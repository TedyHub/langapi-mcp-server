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
  target_langs: languageCodesArraySchema.describe("Target language codes to translate to. Can include NEW languages not yet in the project (e.g., ['cs', 'de'] to add Czech and German)"),
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
    "Add new languages or sync existing translations via LangAPI. Use this tool to: (1) ADD translations for new languages like Czech, Spanish, French - creates new locale files automatically, (2) SYNC existing translations when source content changes. Supports any valid language code (e.g., 'cs' for Czech, 'de' for German). Default is dry_run=true for preview.",
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

      // ========== PER-FILE PROCESSING APPROACH ==========
      // Process each source file separately:
      // 1. For each source file, determine which keys need syncing
      // 2. Make one API call per file → all target languages
      // 3. Write to corresponding target files
      // This ensures correct file mapping without namespace matching bugs

      let totalCreditsUsed = 0;
      let totalWordsToTranslate = 0;
      let currentBalance = 0;

      // Track results per language (aggregated across files)
      const langResults: Map<string, {
        translated_count: number;
        skipped_keys?: string[];
        files_written: string[];
      }> = new Map();

      // Initialize results for all target languages
      for (const lang of input.target_langs) {
        langResults.set(lang, { translated_count: 0, files_written: [] });
      }

      // Track completed files for partial error reporting
      const completedFiles: string[] = [];
      const allFilesWritten: string[] = [];

      // Process each source file
      for (const sourceFileData of sourceFilesData) {
        const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

        // Filter delta content to only keys in this source file
        const fileKeysInDelta = localDelta.contentToSync.filter(
          (item) => sourceFileKeys.has(item.key)
        );

        // Determine which languages need this file's translations
        // and what content to sync per language
        const langContentMap: Map<string, Array<{ key: string; value: string }>> = new Map();

        for (const targetLang of input.target_langs) {
          // Compute target file path
          const targetFilePath = computeTargetFilePath(
            sourceFileData.file.path,
            input.source_lang,
            targetLang
          );

          if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
            continue;
          }

          const resolvedPath = resolve(targetFilePath);
          if (!isPathWithinProject(resolvedPath, projectPath)) {
            continue;
          }

          // Determine base content for this file+language combination
          const isMissingLang = missingLanguages.includes(targetLang);

          // Check if this specific target file exists
          let targetFileExists = false;
          let existingTargetKeys = new Set<string>();
          try {
            const targetContent = await readFile(resolvedPath, "utf-8");
            targetFileExists = true;
            const parsed = parseJsonWithFormat(targetContent);
            if (parsed) {
              const flatTarget = flattenJson(parsed.data as Record<string, unknown>);
              for (const item of flatTarget) {
                if (item.value && item.value.trim() !== "") {
                  existingTargetKeys.add(item.key);
                }
              }
            }
          } catch {
            // File doesn't exist
          }

          // Determine what content to sync
          let contentToSync: Array<{ key: string; value: string }>;

          if (isMissingLang || !targetFileExists) {
            // New language or missing file: sync all keys from this source file
            contentToSync = sourceFileData.flatContent;
          } else if (!cachedContent) {
            // No cache: sync only keys missing from target
            contentToSync = sourceFileData.flatContent.filter(
              (item) => !existingTargetKeys.has(item.key)
            );
          } else {
            // Has cache: use delta, but only keys from this file
            contentToSync = fileKeysInDelta;
          }

          // Apply skip_keys filter
          const skipSet = getSkipKeysForLang(input.skip_keys, targetLang);
          const filteredContent = contentToSync.filter(
            (item) => !skipSet.has(item.key)
          );

          // Track skipped keys
          if (skipSet.size > 0) {
            const skippedInContent = contentToSync
              .filter((item) => skipSet.has(item.key))
              .map((item) => item.key);
            if (skippedInContent.length > 0) {
              const existing = skippedKeysReport[targetLang] || [];
              skippedKeysReport[targetLang] = [...new Set([...existing, ...skippedInContent])];
            }
          }

          if (filteredContent.length > 0) {
            langContentMap.set(targetLang, filteredContent);
          }
        }

        // Skip API call if no languages need this file
        if (langContentMap.size === 0) {
          completedFiles.push(sourceFileData.file.path);
          continue;
        }

        // Collect all unique keys to sync for this file (union across all languages)
        const allKeysToSync = new Set<string>();
        for (const content of langContentMap.values()) {
          for (const item of content) {
            allKeysToSync.add(item.key);
          }
        }

        // Get source content for these keys
        const contentForApi = sourceFileData.flatContent.filter(
          (item) => allKeysToSync.has(item.key)
        );

        if (contentForApi.length === 0) {
          completedFiles.push(sourceFileData.file.path);
          continue;
        }

        // Make API call for this file → all languages that need it
        const langsNeedingSync = Array.from(langContentMap.keys());

        const response = await client.sync({
          source_lang: input.source_lang,
          target_langs: langsNeedingSync,
          content: contentForApi,
          dry_run: input.dry_run,
        });

        // Handle API error
        if (!response.success) {
          // Return partial error with info about completed files
          if (completedFiles.length > 0) {
            const completedLangs = Array.from(langResults.entries())
              .filter(([_, r]) => r.translated_count > 0 || r.files_written.length > 0)
              .map(([lang]) => lang);

            const output: SyncPartialErrorOutput = {
              success: false,
              partial_results: {
                languages_completed: completedLangs,
                files_written: allFilesWritten,
                credits_used: totalCreditsUsed,
              },
              error: {
                code: response.error.code,
                message: response.error.message,
                failed_language: langsNeedingSync[0],
                remaining_languages: langsNeedingSync,
                current_balance: response.error.currentBalance,
                required_credits: response.error.requiredCredits,
                top_up_url: response.error.topUpUrl,
              },
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            };
          }

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

        // Handle dry run response - accumulate costs
        if ("delta" in response && response.cost) {
          totalWordsToTranslate += response.cost.wordsToTranslate || 0;
          totalCreditsUsed += response.cost.creditsRequired || 0;
          currentBalance = response.cost.currentBalance || 0;
          completedFiles.push(sourceFileData.file.path);
          continue;
        }

        // Handle execute response - write files
        if ("results" in response && response.cost) {
          totalCreditsUsed += response.cost.creditsUsed || 0;
          currentBalance = response.cost.balanceAfterSync || 0;

          // Write translations for each language
          for (const result of response.results) {
            const targetLang = result.language;

            // Always compute target path from source (no namespace matching!)
            const targetFilePath = computeTargetFilePath(
              sourceFileData.file.path,
              input.source_lang,
              targetLang
            );

            if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
              continue;
            }

            const resolvedPath = resolve(targetFilePath);
            if (!isPathWithinProject(resolvedPath, projectPath)) {
              continue;
            }

            if (input.write_to_files) {
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
              const newTranslations = unflattenJson(result.translations);
              let mergedContent = deepMerge(existingContent, newTranslations);
              mergedContent = removeExtraKeys(mergedContent, sourceFileKeys);

              // Write file
              await mkdir(dirname(resolvedPath), { recursive: true });
              const fileContent = stringifyWithFormat(mergedContent, sourceFileData.format);
              await writeFile(resolvedPath, fileContent, "utf-8");

              allFilesWritten.push(resolvedPath);

              // Update per-language results
              const langResult = langResults.get(targetLang)!;
              langResult.translated_count += result.translatedCount;
              langResult.files_written.push(resolvedPath);
            } else {
              // Just track count without writing
              const langResult = langResults.get(targetLang)!;
              langResult.translated_count += result.translatedCount;
            }
          }

          completedFiles.push(sourceFileData.file.path);
        }
      }

      // Update cache after all files processed
      if (input.write_to_files && !input.dry_run) {
        await writeSyncCache(projectPath, input.source_lang, flatContent);
      }

      // Build final response
      if (input.dry_run) {
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
          message: `Preview: ${localDelta.contentToSync.length} keys to sync across ${sourceFilesData.length} file(s), ${totalCreditsUsed} credits required. Run with dry_run=false to execute.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        };
      }

      // Build results array from aggregated per-language data
      const results: Array<{
        language: string;
        translated_count: number;
        skipped_keys?: string[];
        file_written: string | null;
      }> = [];

      for (const [lang, data] of langResults) {
        results.push({
          language: lang,
          translated_count: data.translated_count,
          skipped_keys: skippedKeysReport[lang],
          file_written: data.files_written.length > 0 ? data.files_written.join(", ") : null,
        });
      }

      const totalTranslated = results.reduce((sum, r) => sum + r.translated_count, 0);
      const skippedMsg = Object.keys(skippedKeysReport).length > 0
        ? ` Skipped: ${JSON.stringify(skippedKeysReport)}`
        : "";

      const output: SyncExecuteOutput = {
        success: true,
        dry_run: false,
        results,
        cost: {
          credits_used: totalCreditsUsed,
          balance_after_sync: currentBalance,
        },
        message: `Sync complete. ${totalTranslated} keys translated across ${input.target_langs.length} languages.${skippedMsg}`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );
}
