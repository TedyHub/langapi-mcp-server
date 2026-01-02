/**
 * sync_translations MCP Tool
 * Sync translations via LangAPI /v1/sync endpoint
 */

import { z } from "zod";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales, type LocaleFile } from "../locale-detection/index.js";
import {
  flattenJson,
  unflattenJson,
  parseJsonSafe,
} from "../utils/json-parser.js";
import {
  parseJsonWithFormat,
  stringifyWithFormat,
  type JsonFormat,
} from "../utils/format-preserve.js";
import { LangAPIClient } from "../api/client.js";
import { isApiKeyConfigured } from "../config/env.js";
import {
  languageCodeSchema,
  languageCodesArraySchema,
  isPathWithinProject,
} from "../utils/validation.js";
import {
  readSyncCache,
  writeSyncCache,
  detectLocalDelta,
} from "../utils/sync-cache.js";

// Input schema
const SyncTranslationsSchema = z.object({
  source_lang: languageCodeSchema.describe("Source language code (e.g., 'en', 'pt-BR')"),
  target_langs: languageCodesArraySchema.describe("Target language codes to sync"),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "If true, only preview changes without syncing. Default: true (safe mode)"
    ),
  project_path: z
    .string()
    .optional()
    .describe("Root path of the project. Defaults to current working directory."),
  write_to_files: z
    .boolean()
    .default(true)
    .describe("If true, write translated content back to local files"),
  skip_keys: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe("Keys to skip per language, e.g., { 'fr': ['subtitle', 'brand'] }"),
});

export type SyncTranslationsInput = z.infer<typeof SyncTranslationsSchema>;

// Output types
interface SyncPreviewOutput {
  success: true;
  dry_run: true;
  delta: {
    new_keys: string[];
    changed_keys: string[];
    total_keys_to_sync: number;
  };
  cost: {
    words_to_translate: number;
    credits_required: number;
    current_balance: number;
    balance_after_sync: number;
  };
  message: string;
}

interface SyncExecuteOutput {
  success: true;
  dry_run: false;
  results: Array<{
    language: string;
    translated_count: number;
    skipped_keys?: string[];
    file_written: string | null;
  }>;
  cost: {
    credits_used: number;
    balance_after_sync: number;
  };
  message: string;
}

interface SyncErrorOutput {
  success: false;
  error: {
    code: string;
    message: string;
    current_balance?: number;
    required_credits?: number;
    top_up_url?: string;
  };
}

interface SyncPartialErrorOutput {
  success: false;
  partial_results: {
    languages_completed: string[];
    files_written: string[];
    credits_used: number;
  };
  error: {
    code: string;
    message: string;
    failed_language: string;
    remaining_languages: string[];
    current_balance?: number;
    required_credits?: number;
    top_up_url?: string;
  };
}

type SyncOutput = SyncPreviewOutput | SyncExecuteOutput | SyncErrorOutput | SyncPartialErrorOutput;

/**
 * Get keys to skip for a specific language
 */
function getSkipKeysForLang(
  skipKeys: Record<string, string[]> | undefined,
  lang: string
): Set<string> {
  if (!skipKeys) return new Set();
  const keys = skipKeys[lang] || [];
  return new Set(keys);
}

/**
 * Deep merge two objects, with source values overriding target values
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      // Both are objects, merge recursively
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      // Source value overrides target
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Remove keys from a nested object using flattened key notation (e.g., "greeting.hello")
 */
function removeKeysFromObject(
  obj: Record<string, unknown>,
  keysToRemove: string[]
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(obj)); // Deep clone

  for (const key of keysToRemove) {
    const parts = key.split(".");
    let current: Record<string, unknown> = result;

    // Navigate to the parent of the key to remove
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] && typeof current[parts[i]] === "object") {
        current = current[parts[i]] as Record<string, unknown>;
      } else {
        // Path doesn't exist, nothing to remove
        break;
      }
    }

    // Delete the final key
    delete current[parts[parts.length - 1]];
  }

  return result;
}

/**
 * Remove any keys from target that don't exist in source (to keep target in sync with source structure)
 */
function removeExtraKeys(
  targetObj: Record<string, unknown>,
  sourceKeys: Set<string>
): Record<string, unknown> {
  // Flatten the target to get all its keys
  const targetFlat = flattenJson(targetObj);

  // Find keys in target that don't exist in source
  const extraKeys: string[] = [];
  for (const item of targetFlat) {
    if (!sourceKeys.has(item.key)) {
      extraKeys.push(item.key);
    }
  }

  if (extraKeys.length === 0) {
    return targetObj;
  }

  return removeKeysFromObject(targetObj, extraKeys);
}

/**
 * Compute target file path by replacing source language with target language.
 * Handles both directory-based (locales/en/file.json) and flat (locales/en.json) structures.
 */
function computeTargetFilePath(
  sourcePath: string,
  sourceLang: string,
  targetLang: string
): string | null {
  // Try directory-based replacement first: /en/ → /ko/
  const dirPattern = `/${sourceLang}/`;
  if (sourcePath.includes(dirPattern)) {
    return sourcePath.replace(dirPattern, `/${targetLang}/`);
  }

  // Try flat file replacement: /en.json → /ko.json
  const filePattern = `/${sourceLang}.json`;
  if (sourcePath.endsWith(filePattern)) {
    return sourcePath.slice(0, -filePattern.length) + `/${targetLang}.json`;
  }

  // Try filename with prefix: messages.en.json → messages.ko.json
  const prefixPattern = `.${sourceLang}.json`;
  if (sourcePath.endsWith(prefixPattern)) {
    return sourcePath.slice(0, -prefixPattern.length) + `.${targetLang}.json`;
  }

  // Cannot determine target path
  return null;
}

/**
 * Register the sync_translations tool with the MCP server
 */
export function registerSyncTranslations(server: McpServer): void {
  server.tool(
    "sync_translations",
    "Sync translations by calling the LangAPI /v1/sync endpoint. Default is dry_run=true (preview mode) for safety. Set dry_run=false to actually perform the sync.",
    SyncTranslationsSchema.shape,
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const input = SyncTranslationsSchema.parse(args);
      const projectPath = input.project_path || process.cwd();

      // Check if API key is configured
      if (!isApiKeyConfigured()) {
        const output: SyncErrorOutput = {
          success: false,
          error: {
            code: "NO_API_KEY",
            message:
              "No API key configured. Set the LANGAPI_API_KEY environment variable.",
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Detect locales
      const detection = await detectLocales(projectPath, false);

      // Find source locale
      const sourceLocale = detection.locales.find(
        (l) => l.lang === input.source_lang
      );
      if (!sourceLocale) {
        const output: SyncErrorOutput = {
          success: false,
          error: {
            code: "SOURCE_NOT_FOUND",
            message: `Source language '${input.source_lang}' not found in project`,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Track content per source file for namespace preservation
      interface SourceFileData {
        file: LocaleFile;
        content: Record<string, unknown>;
        flatContent: Array<{ key: string; value: string }>;
        format: JsonFormat;
      }

      const sourceFilesData: SourceFileData[] = [];

      for (const file of sourceLocale.files) {
        const content = await readFile(file.path, "utf-8");
        const parsed = parseJsonWithFormat(content);
        if (parsed) {
          const flatContent = flattenJson(parsed.data as Record<string, unknown>);
          sourceFilesData.push({
            file,
            content: parsed.data as Record<string, unknown>,
            flatContent,
            format: parsed.format,
          });
        }
      }

      // Also create merged versions for backward compatibility with cache/delta logic
      const sourceContent: Record<string, unknown> = {};
      let sourceFormat: JsonFormat = { indent: "  ", trailingNewline: true };
      for (const fileData of sourceFilesData) {
        Object.assign(sourceContent, fileData.content);
        sourceFormat = fileData.format;
      }

      // Flatten source content for API
      const flatContent = flattenJson(sourceContent);
      const sourceKeys = new Set(flatContent.map((item) => item.key));

      // Read cache and detect local delta
      const cachedContent = await readSyncCache(projectPath, input.source_lang);
      const localDelta = detectLocalDelta(flatContent, cachedContent);

      // Detect missing target languages (files that don't exist yet)
      const missingLanguages: string[] = [];
      const existingLanguages: string[] = [];
      for (const targetLang of input.target_langs) {
        const targetLocale = detection.locales.find((l) => l.lang === targetLang);
        if (!targetLocale || targetLocale.files.length === 0) {
          missingLanguages.push(targetLang);
        } else {
          existingLanguages.push(targetLang);
        }
      }

      // Detect missing target FILES (not just languages)
      // A language may exist but be missing some namespace files
      const languagesWithMissingFiles: string[] = [];

      for (const targetLang of existingLanguages) {
        for (const sourceFileData of sourceFilesData) {
          // Compute expected target file path
          const targetFilePath = computeTargetFilePath(
            sourceFileData.file.path,
            input.source_lang,
            targetLang
          );

          // Skip if path computation failed or would overwrite source
          if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
            continue;
          }

          // Check if file exists
          try {
            await readFile(targetFilePath, "utf-8");
          } catch {
            // File doesn't exist - this language has missing files
            if (!languagesWithMissingFiles.includes(targetLang)) {
              languagesWithMissingFiles.push(targetLang);
            }
          }
        }
      }

      // If no content to sync AND no missing languages AND no missing files, return early
      if (localDelta.contentToSync.length === 0 && missingLanguages.length === 0 && languagesWithMissingFiles.length === 0) {
        if (input.dry_run) {
          // Check for extra keys in target files even in dry_run mode
          let totalExtraKeys = 0;
          const extraKeysByLang: Record<string, string[]> = {};

          for (const targetLang of input.target_langs) {
            const langExtraKeys: string[] = [];

            // Check each source file's corresponding target file
            for (const sourceFileData of sourceFilesData) {
              const targetFilePath = computeTargetFilePath(
                sourceFileData.file.path,
                input.source_lang,
                targetLang
              );

              // Skip if path computation failed or would overwrite source
              if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
                continue;
              }

              const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

              try {
                const content = await readFile(targetFilePath, "utf-8");
                const parsed = parseJsonSafe(content);
                if (parsed) {
                  const targetFlat = flattenJson(parsed as Record<string, unknown>);
                  const extraKeys = targetFlat.filter((t) => !sourceFileKeys.has(t.key)).map((t) => t.key);
                  langExtraKeys.push(...extraKeys);
                }
              } catch {
                // File doesn't exist or can't be read
              }
            }

            if (langExtraKeys.length > 0) {
              extraKeysByLang[targetLang] = langExtraKeys;
              totalExtraKeys += langExtraKeys.length;
            }
          }

          const output: SyncPreviewOutput = {
            success: true,
            dry_run: true,
            delta: {
              new_keys: [],
              changed_keys: [],
              total_keys_to_sync: 0,
            },
            cost: {
              words_to_translate: 0,
              credits_required: 0,
              current_balance: 0,
              balance_after_sync: 0,
            },
            message: totalExtraKeys > 0
              ? `No translations needed, but ${totalExtraKeys} extra keys found in target files will be removed. Run with dry_run=false to clean up. Extra keys: ${JSON.stringify(extraKeysByLang)}`
              : "No changes detected. All keys are already synced.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          };
        }
        // For non-dry_run with no source changes, still check for extra keys in target files
        const results: Array<{
          language: string;
          translated_count: number;
          file_written: string | null;
          keys_removed?: number;
        }> = [];

        if (input.write_to_files) {
          for (const targetLang of input.target_langs) {
            const filesWritten: string[] = [];
            let totalKeysRemovedForLang = 0;

            // Process each source file's corresponding target file
            for (const sourceFileData of sourceFilesData) {
              // Compute target file path
              const targetFilePath = computeTargetFilePath(
                sourceFileData.file.path,
                input.source_lang,
                targetLang
              );

              // Skip if path computation failed or would overwrite source
              if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
                continue;
              }

              const resolvedPath = resolve(targetFilePath);
              if (!isPathWithinProject(resolvedPath, projectPath)) {
                continue;
              }

              // Get the keys that belong to this source file
              const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

              try {
                const existingContent = await readFile(resolvedPath, "utf-8");
                const parsed = parseJsonSafe(existingContent);
                if (!parsed) {
                  continue;
                }

                // Check for and remove extra keys
                const cleaned = removeExtraKeys(parsed as Record<string, unknown>, sourceFileKeys);
                const cleanedStr = stringifyWithFormat(cleaned, sourceFileData.format);
                const originalStr = stringifyWithFormat(parsed as Record<string, unknown>, sourceFileData.format);

                if (cleanedStr !== originalStr) {
                  // Extra keys were removed, write the cleaned file
                  await writeFile(resolvedPath, cleanedStr, "utf-8");
                  const keysRemoved = flattenJson(parsed as Record<string, unknown>).length - flattenJson(cleaned).length;
                  filesWritten.push(resolvedPath);
                  totalKeysRemovedForLang += keysRemoved;
                }
              } catch {
                // File doesn't exist or can't be read
              }
            }

            results.push({
              language: targetLang,
              translated_count: 0,
              file_written: filesWritten.length > 0 ? filesWritten.join(", ") : null,
              keys_removed: totalKeysRemovedForLang > 0 ? totalKeysRemovedForLang : undefined,
            });
          }
        } else {
          for (const targetLang of input.target_langs) {
            results.push({ language: targetLang, translated_count: 0, file_written: null });
          }
        }

        await writeSyncCache(projectPath, input.source_lang, flatContent);

        const filesCleanedCount = results.filter((r) => r.keys_removed && r.keys_removed > 0).length;
        const totalKeysRemoved = results.reduce((sum, r) => sum + (r.keys_removed || 0), 0);

        const output: SyncExecuteOutput = {
          success: true,
          dry_run: false,
          results: results.map(({ language, translated_count, file_written }) => ({
            language,
            translated_count,
            file_written,
          })),
          cost: {
            credits_used: 0,
            balance_after_sync: 0,
          },
          message: filesCleanedCount > 0
            ? `No translations needed. Removed ${totalKeysRemoved} extra keys from ${filesCleanedCount} file(s).`
            : "No changes detected. All keys are already synced.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Create API client
      const client = LangAPIClient.create();

      // Track skipped keys per language for reporting
      const skippedKeysReport: Record<string, string[]> = {};

      // Check if we need per-language filtering
      const hasSkipKeys = input.skip_keys && Object.keys(input.skip_keys).length > 0;
      const hasMissingLanguages = missingLanguages.length > 0;

      // If we have missing languages, missing files, skip_keys, OR no cache, process per-language
      // When cache is null, we need per-language processing to filter against existing target translations
      const hasLanguagesWithMissingFiles = languagesWithMissingFiles.length > 0;
      const needsTargetFiltering = !cachedContent && existingLanguages.length > 0;
      if (hasMissingLanguages || hasSkipKeys || hasLanguagesWithMissingFiles || needsTargetFiltering) {
        // Process each language one at a time: API call → write files → next language
        // This ensures partial results are saved immediately and not lost on error
        let totalCreditsUsed = 0;
        let totalWordsToTranslate = 0;
        let currentBalance = 0;

        // Track completed languages and their results
        const completedResults: Array<{
          language: string;
          translated_count: number;
          skipped_keys?: string[];
          file_written: string | null;
        }> = [];
        const completedLanguages: string[] = [];
        const allFilesWritten: string[] = [];

        for (const targetLang of input.target_langs) {
          // Determine base content: ALL keys for missing languages or languages with missing files
          const isMissingLang = missingLanguages.includes(targetLang);
          const hasMissingFiles = languagesWithMissingFiles.includes(targetLang);
          const needsFullSync = isMissingLang || hasMissingFiles;
          let baseContent = needsFullSync ? flatContent : localDelta.contentToSync;

          // Filter against existing target translations (not just cache)
          // This ensures we only sync keys that are actually missing from target files
          // Only apply when cache is null - otherwise cache delta already handles new/changed correctly
          if (!isMissingLang && !cachedContent) {
            const targetLocale = detection.locales.find((l) => l.lang === targetLang);
            if (targetLocale && targetLocale.files.length > 0) {
              // Read all target files and collect existing keys
              const existingTargetKeys = new Set<string>();
              for (const targetFile of targetLocale.files) {
                try {
                  const targetContent = await readFile(targetFile.path, "utf-8");
                  const parsed = parseJsonWithFormat(targetContent);
                  if (parsed) {
                    const flatTarget = flattenJson(parsed.data as Record<string, unknown>);
                    for (const item of flatTarget) {
                      // Only count as "existing" if it has a non-empty value
                      if (item.value && item.value.trim() !== "") {
                        existingTargetKeys.add(item.key);
                      }
                    }
                  }
                } catch {
                  // File read failed, treat as missing
                }
              }
              // Filter out keys that already exist in target
              baseContent = baseContent.filter((item) => !existingTargetKeys.has(item.key));
            }
          }

          // Apply skip_keys filter on top of base content
          const skipSet = getSkipKeysForLang(input.skip_keys, targetLang);
          const filteredContent = baseContent.filter(
            (item) => !skipSet.has(item.key)
          );

          // Track skipped keys for this language
          if (skipSet.size > 0) {
            const skippedInContent = baseContent
              .filter((item) => skipSet.has(item.key))
              .map((item) => item.key);
            if (skippedInContent.length > 0) {
              skippedKeysReport[targetLang] = skippedInContent;
            }
          }

          // Skip API call if no content after filtering
          if (filteredContent.length === 0) {
            completedResults.push({
              language: targetLang,
              translated_count: 0,
              skipped_keys: skippedKeysReport[targetLang],
              file_written: null,
            });
            completedLanguages.push(targetLang);
            continue;
          }

          // Make API call for this language
          const response = await client.sync({
            source_lang: input.source_lang,
            target_langs: [targetLang],
            content: filteredContent,
            dry_run: input.dry_run,
          });

          // Handle API error - return immediately (previous languages already saved)
          if (!response.success) {
            const currentIndex = input.target_langs.indexOf(targetLang);
            const remainingLangs = input.target_langs.slice(currentIndex + 1);

            // Return partial error with info about completed languages
            if (completedLanguages.length > 0) {
              const output: SyncPartialErrorOutput = {
                success: false,
                partial_results: {
                  languages_completed: completedLanguages,
                  files_written: allFilesWritten,
                  credits_used: totalCreditsUsed,
                },
                error: {
                  code: response.error.code,
                  message: response.error.message,
                  failed_language: targetLang,
                  remaining_languages: remainingLangs,
                  current_balance: response.error.currentBalance,
                  required_credits: response.error.requiredCredits,
                  top_up_url: response.error.topUpUrl,
                },
              };
              return {
                content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
              };
            }

            // No completed languages - return simple error
            const output: SyncErrorOutput = {
              success: false,
              error: {
                code: response.error.code,
                message: response.error.message,
                current_balance: response.error.currentBalance,
                required_credits: response.error.requiredCredits,
                top_up_url: response.error.topUpUrl,
              },
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            };
          }

          // Handle dry run response - just accumulate costs
          if ("delta" in response && response.cost) {
            totalWordsToTranslate += response.cost.wordsToTranslate || 0;
            totalCreditsUsed += response.cost.creditsRequired || 0;
            currentBalance = response.cost.currentBalance || 0;
            completedLanguages.push(targetLang);
            continue;
          }

          // Handle execute response - write files immediately for this language
          if ("results" in response && response.cost) {
            totalCreditsUsed += response.cost.creditsUsed || 0;
            currentBalance = response.cost.balanceAfterSync || 0;

            const result = response.results[0];
            if (!result) {
              continue;
            }

            const filesWrittenForLang: string[] = [];

            // Write files for this language if requested
            if (input.write_to_files) {
              // Check if target locale exists (use detected files)
              const targetLocale = detection.locales.find((l) => l.lang === targetLang);

              for (const sourceFileData of sourceFilesData) {
                // Compute target file path
                let targetFilePath: string | null = null;

                if (targetLocale && targetLocale.files.length > 0) {
                  // Use existing detected target file path
                  // Match by namespace or use first file for single-file projects
                  const matchingFile = targetLocale.files.find(
                    (f) => f.namespace === sourceFileData.file.namespace
                  ) || targetLocale.files[0];
                  targetFilePath = matchingFile.path;
                } else {
                  // New language - compute path from source
                  targetFilePath = computeTargetFilePath(
                    sourceFileData.file.path,
                    input.source_lang,
                    targetLang
                  );
                }

                // Safety check: prevent overwriting source file
                if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
                  continue;
                }

                const resolvedPath = resolve(targetFilePath);
                if (!isPathWithinProject(resolvedPath, projectPath)) {
                  continue;
                }

                // Get keys that belong to this source file
                const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

                // Filter translations to only those from this source file
                const fileTranslations = result.translations.filter(
                  (t) => sourceFileKeys.has(t.key)
                );

                if (fileTranslations.length === 0) {
                  continue;
                }

                // Read existing target file content (if exists)
                let existingContent: Record<string, unknown> = {};
                try {
                  const existingFileContent = await readFile(resolvedPath, "utf-8");
                  const parsed = parseJsonSafe(existingFileContent);
                  if (parsed) {
                    existingContent = parsed as Record<string, unknown>;
                  }
                } catch {
                  // File doesn't exist yet, start with empty object
                }

                // Unflatten and merge translations
                const newTranslations = unflattenJson(fileTranslations);
                let mergedContent = deepMerge(existingContent, newTranslations);
                mergedContent = removeExtraKeys(mergedContent, sourceFileKeys);

                // Write file
                await mkdir(dirname(resolvedPath), { recursive: true });
                const fileContent = stringifyWithFormat(mergedContent, sourceFileData.format);
                await writeFile(resolvedPath, fileContent, "utf-8");

                filesWrittenForLang.push(resolvedPath);
                allFilesWritten.push(resolvedPath);
              }
            }

            completedResults.push({
              language: targetLang,
              translated_count: result.translatedCount,
              skipped_keys: skippedKeysReport[targetLang],
              file_written: filesWrittenForLang.length > 0 ? filesWrittenForLang.join(", ") : null,
            });
            completedLanguages.push(targetLang);

            // Update cache after each successful language write
            if (input.write_to_files) {
              await writeSyncCache(projectPath, input.source_lang, flatContent);
            }
          }
        }

        // All languages processed successfully

        // Handle dry run response
        if (input.dry_run) {
          const skippedMsg = Object.keys(skippedKeysReport).length > 0
            ? ` Skipped keys: ${JSON.stringify(skippedKeysReport)}`
            : "";
          const output: SyncPreviewOutput = {
            success: true,
            dry_run: true,
            delta: {
              new_keys: localDelta.newKeys,
              changed_keys: localDelta.changedKeys,
              total_keys_to_sync: localDelta.contentToSync.length,
            },
            cost: {
              words_to_translate: totalWordsToTranslate,
              credits_required: totalCreditsUsed,
              current_balance: currentBalance,
              balance_after_sync: currentBalance - totalCreditsUsed,
            },
            message: `Preview: ${localDelta.contentToSync.length} keys to sync, ${totalCreditsUsed} credits required.${skippedMsg} Run with dry_run=false to execute.`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          };
        }

        // Return success with all completed results
        const skippedMsg = Object.keys(skippedKeysReport).length > 0
          ? ` Skipped: ${JSON.stringify(skippedKeysReport)}`
          : "";
        const totalTranslated = completedResults.reduce((sum, r) => sum + r.translated_count, 0);
        const output: SyncExecuteOutput = {
          success: true,
          dry_run: false,
          results: completedResults,
          cost: {
            credits_used: totalCreditsUsed,
            balance_after_sync: currentBalance,
          },
          message: `Sync complete. ${totalTranslated} keys translated across ${completedLanguages.length} languages.${skippedMsg}`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // No skip_keys - use batch approach
      const response = await client.sync({
        source_lang: input.source_lang,
        target_langs: input.target_langs,
        content: localDelta.contentToSync,
        dry_run: input.dry_run,
      });

      // Handle error response
      if (!response.success) {
        const output: SyncErrorOutput = {
          success: false,
          error: {
            code: response.error.code,
            message: response.error.message,
            current_balance: response.error.currentBalance,
            required_credits: response.error.requiredCredits,
            top_up_url: response.error.topUpUrl,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Handle dry run response - use local delta for accurate new/changed detection
      if (input.dry_run && "delta" in response) {
        const output: SyncPreviewOutput = {
          success: true,
          dry_run: true,
          delta: {
            new_keys: localDelta.newKeys,
            changed_keys: localDelta.changedKeys,
            total_keys_to_sync: localDelta.contentToSync.length,
          },
          cost: {
            words_to_translate: response.cost.wordsToTranslate,
            credits_required: response.cost.creditsRequired,
            current_balance: response.cost.currentBalance,
            balance_after_sync: response.cost.balanceAfterSync,
          },
          message: `Preview: ${localDelta.contentToSync.length} keys to sync (${localDelta.newKeys.length} new, ${localDelta.changedKeys.length} changed), ${response.cost.creditsRequired} credits required. Run with dry_run=false to execute.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Handle execute response
      if ("results" in response) {
        const results: Array<{
          language: string;
          translated_count: number;
          file_written: string | null;
        }> = [];

        // Write translated content to files if requested
        if (input.write_to_files) {
          for (const result of response.results) {
            const lang = result.language;
            const filesWritten: string[] = [];

            // Write to each source file's corresponding target file
            for (const sourceFileData of sourceFilesData) {
              // Compute target file path
              const targetFilePath = computeTargetFilePath(
                sourceFileData.file.path,
                input.source_lang,
                lang
              );

              // Skip if path computation failed or would overwrite source
              if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
                continue;
              }

              const resolvedPath = resolve(targetFilePath);
              if (!isPathWithinProject(resolvedPath, projectPath)) {
                continue;
              }

              // Get the keys that belong to this source file
              const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

              // Filter translations to only those from this source file
              const fileTranslations = result.translations.filter(
                (t) => sourceFileKeys.has(t.key)
              );

              if (fileTranslations.length === 0) {
                continue;
              }

              // Read existing target file content (if exists)
              let existingContent: Record<string, unknown> = {};
              try {
                const existingFileContent = await readFile(resolvedPath, "utf-8");
                const parsed = parseJsonSafe(existingFileContent);
                if (parsed) {
                  existingContent = parsed as Record<string, unknown>;
                }
              } catch {
                // File doesn't exist yet, start with empty object
              }

              // Unflatten the new translations
              const newTranslations = unflattenJson(fileTranslations);

              // Deep merge: new translations override existing ones
              let mergedContent = deepMerge(existingContent, newTranslations);

              // Remove any keys in target that don't exist in this source file
              mergedContent = removeExtraKeys(mergedContent, sourceFileKeys);

              // Ensure directory exists
              await mkdir(dirname(resolvedPath), { recursive: true });

              // Write file with format preservation
              const fileContent = stringifyWithFormat(mergedContent, sourceFileData.format);
              await writeFile(resolvedPath, fileContent, "utf-8");

              filesWritten.push(resolvedPath);
            }

            results.push({
              language: lang,
              translated_count: result.translatedCount,
              file_written: filesWritten.length > 0 ? filesWritten.join(", ") : null,
            });
          }
        } else {
          for (const result of response.results) {
            results.push({
              language: result.language,
              translated_count: result.translatedCount,
              file_written: null,
            });
          }
        }

        // Update cache with current source content after successful sync
        await writeSyncCache(projectPath, input.source_lang, flatContent);

        const output: SyncExecuteOutput = {
          success: true,
          dry_run: false,
          results,
          cost: {
            credits_used: response.cost.creditsUsed,
            balance_after_sync: response.cost.balanceAfterSync,
          },
          message: `Sync complete. ${response.results.reduce(
            (sum, r) => sum + r.translatedCount,
            0
          )} keys translated across ${response.results.length} languages. ${response.cost.creditsUsed} credits used.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Fallback error
      const output: SyncErrorOutput = {
        success: false,
        error: {
          code: "UNEXPECTED_RESPONSE",
          message: "Unexpected response from API",
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );
}
