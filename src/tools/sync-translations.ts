/**
 * sync_translations MCP Tool
 * Sync translations via LangAPI /v1/sync endpoint
 */

import { z } from "zod";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales } from "../locale-detection/index.js";
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

type SyncOutput = SyncPreviewOutput | SyncExecuteOutput | SyncErrorOutput;

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

  console.error(`[SYNC] Removing extra keys not in source: ${extraKeys.join(", ")}`);
  return removeKeysFromObject(targetObj, extraKeys);
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

      // Read source files and merge content
      const sourceContent: Record<string, unknown> = {};
      let sourceFormat: JsonFormat = { indent: "  ", trailingNewline: true };

      for (const file of sourceLocale.files) {
        const content = await readFile(file.path, "utf-8");
        const parsed = parseJsonWithFormat(content);
        if (parsed) {
          Object.assign(sourceContent, parsed.data);
          sourceFormat = parsed.format; // Use last file's format
        }
      }

      // Flatten source content for API
      const flatContent = flattenJson(sourceContent);
      const sourceKeys = new Set(flatContent.map((item) => item.key));
      console.error(`[SYNC] projectPath: ${projectPath}`);
      console.error(`[SYNC] flatContent has ${flatContent.length} keys`);

      // Read cache and detect local delta
      const cachedContent = await readSyncCache(projectPath, input.source_lang);
      console.error(`[SYNC] cachedContent: ${cachedContent ? Object.keys(cachedContent).length + ' keys' : 'null'}`);

      const localDelta = detectLocalDelta(flatContent, cachedContent);
      console.error(`[SYNC] localDelta: ${localDelta.newKeys.length} new, ${localDelta.changedKeys.length} changed, ${localDelta.unchangedKeys.length} unchanged`);

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
      console.error(`[SYNC] Missing languages: ${missingLanguages.join(", ") || "none"}`);
      console.error(`[SYNC] Existing languages: ${existingLanguages.join(", ") || "none"}`);

      // If no content to sync AND no missing languages, return early with accurate delta
      if (localDelta.contentToSync.length === 0 && missingLanguages.length === 0) {
        if (input.dry_run) {
          // Check for extra keys in target files even in dry_run mode
          let totalExtraKeys = 0;
          const extraKeysByLang: Record<string, string[]> = {};

          for (const targetLang of input.target_langs) {
            const targetLocale = detection.locales.find((l) => l.lang === targetLang);
            if (!targetLocale || targetLocale.files.length === 0) continue;

            try {
              const content = await readFile(targetLocale.files[0].path, "utf-8");
              const parsed = parseJsonSafe(content);
              if (parsed) {
                const targetFlat = flattenJson(parsed as Record<string, unknown>);
                const extraKeys = targetFlat.filter((t) => !sourceKeys.has(t.key)).map((t) => t.key);
                if (extraKeys.length > 0) {
                  extraKeysByLang[targetLang] = extraKeys;
                  totalExtraKeys += extraKeys.length;
                }
              }
            } catch {
              // File doesn't exist or can't be read
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
            const targetLocale = detection.locales.find((l) => l.lang === targetLang);
            if (!targetLocale || targetLocale.files.length === 0) {
              results.push({ language: targetLang, translated_count: 0, file_written: null });
              continue;
            }

            const filePath = targetLocale.files[0].path;
            const resolvedPath = resolve(filePath);

            try {
              const existingContent = await readFile(resolvedPath, "utf-8");
              const parsed = parseJsonSafe(existingContent);
              if (!parsed) {
                results.push({ language: targetLang, translated_count: 0, file_written: null });
                continue;
              }

              // Check for and remove extra keys
              const cleaned = removeExtraKeys(parsed as Record<string, unknown>, sourceKeys);
              const cleanedStr = stringifyWithFormat(cleaned, sourceFormat);
              const originalStr = stringifyWithFormat(parsed as Record<string, unknown>, sourceFormat);

              if (cleanedStr !== originalStr) {
                // Extra keys were removed, write the cleaned file
                await writeFile(resolvedPath, cleanedStr, "utf-8");
                const keysRemoved = flattenJson(parsed as Record<string, unknown>).length - flattenJson(cleaned).length;
                console.error(`[SYNC] Removed ${keysRemoved} extra keys from ${targetLang}`);
                results.push({ language: targetLang, translated_count: 0, file_written: resolvedPath, keys_removed: keysRemoved });
              } else {
                results.push({ language: targetLang, translated_count: 0, file_written: null });
              }
            } catch {
              results.push({ language: targetLang, translated_count: 0, file_written: null });
            }
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

      // If we have missing languages OR skip_keys, process per-language
      if (hasMissingLanguages || hasSkipKeys) {
        // Call API per language with filtered content
        let totalCreditsRequired = 0;
        let totalWordsToTranslate = 0;
        let currentBalance = 0;
        const allResults: Array<{ language: string; translatedCount: number; translations: Array<{ key: string; value: string }> }> = [];

        for (const targetLang of input.target_langs) {
          // Determine base content: ALL keys for missing languages, only changes for existing
          const isMissingLang = missingLanguages.includes(targetLang);
          const baseContent = isMissingLang ? flatContent : localDelta.contentToSync;

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
            allResults.push({ language: targetLang, translatedCount: 0, translations: [] });
            continue;
          }

          console.error(`[SYNC] Translating ${filteredContent.length} keys for ${targetLang} (${isMissingLang ? 'new language' : 'existing language'})`);


          const response = await client.sync({
            source_lang: input.source_lang,
            target_langs: [targetLang],
            content: filteredContent,
            dry_run: input.dry_run,
          });

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

          if ("delta" in response && response.cost) {
            // Dry run response
            totalCreditsRequired += response.cost.creditsRequired || 0;
            totalWordsToTranslate += response.cost.wordsToTranslate || 0;
            currentBalance = response.cost.currentBalance || 0;
          } else if ("results" in response && response.cost) {
            // Execute response
            totalCreditsRequired += response.cost.creditsUsed || 0;
            currentBalance = response.cost.balanceAfterSync || 0;
            for (const result of response.results) {
              allResults.push(result);
            }
          }
        }

        // Handle dry run response with skip_keys
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
              credits_required: totalCreditsRequired,
              current_balance: currentBalance,
              balance_after_sync: currentBalance - totalCreditsRequired,
            },
            message: `Preview: ${localDelta.contentToSync.length} keys to sync, ${totalCreditsRequired} credits required.${skippedMsg} Run with dry_run=false to execute.`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          };
        }

        // For execute mode, continue to file writing with allResults
        // We'll handle this in the results section below by setting response
        const response = {
          success: true as const,
          results: allResults,
          cost: { creditsUsed: totalCreditsRequired, balanceAfterSync: currentBalance - totalCreditsRequired },
        };

        // Continue to "Handle execute response" section below
        if ("results" in response) {
          const results: Array<{
            language: string;
            translated_count: number;
            skipped_keys?: string[];
            file_written: string | null;
          }> = [];

          // Write translated content to files if requested
          if (input.write_to_files) {
            for (const result of response.results) {
              const lang = result.language;

              // Find existing target locale to match directory structure
              const targetLocale = detection.locales.find((l) => l.lang === lang);

              let filePath: string;
              if (targetLocale && targetLocale.files.length > 0) {
                filePath = targetLocale.files[0].path;
              } else {
                const sourceFile = sourceLocale.files[0];
                filePath = sourceFile.path.replace(`/${input.source_lang}`, `/${lang}`);
                filePath = filePath.replace(`${input.source_lang}.json`, `${lang}.json`);
              }

              const resolvedPath = resolve(filePath);
              if (!isPathWithinProject(resolvedPath, projectPath)) {
                results.push({
                  language: lang,
                  translated_count: result.translatedCount,
                  skipped_keys: skippedKeysReport[lang],
                  file_written: null,
                });
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
              const newTranslations = unflattenJson(result.translations);

              // Deep merge: new translations override existing ones
              let mergedContent = deepMerge(existingContent, newTranslations);

              // Remove any keys in target that don't exist in source
              mergedContent = removeExtraKeys(mergedContent, sourceKeys);

              await mkdir(dirname(resolvedPath), { recursive: true });
              const fileContent = stringifyWithFormat(mergedContent, sourceFormat);
              await writeFile(resolvedPath, fileContent, "utf-8");

              results.push({
                language: lang,
                translated_count: result.translatedCount,
                skipped_keys: skippedKeysReport[lang],
                file_written: resolvedPath,
              });
            }
          } else {
            for (const result of response.results) {
              results.push({
                language: result.language,
                translated_count: result.translatedCount,
                skipped_keys: skippedKeysReport[result.language],
                file_written: null,
              });
            }
          }

          await writeSyncCache(projectPath, input.source_lang, flatContent);

          const skippedMsg = Object.keys(skippedKeysReport).length > 0
            ? ` Skipped: ${JSON.stringify(skippedKeysReport)}`
            : "";
          const output: SyncExecuteOutput = {
            success: true,
            dry_run: false,
            results,
            cost: {
              credits_used: response.cost.creditsUsed,
              balance_after_sync: response.cost.balanceAfterSync,
            },
            message: `Sync complete. ${response.results.reduce((sum, r) => sum + r.translatedCount, 0)} keys translated.${skippedMsg}`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          };
        }
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

            // Find existing target locale to match directory structure
            const targetLocale = detection.locales.find((l) => l.lang === lang);

            let filePath: string;
            if (targetLocale && targetLocale.files.length > 0) {
              // Use existing file path
              filePath = targetLocale.files[0].path;
            } else {
              // Create new file based on source structure
              const sourceFile = sourceLocale.files[0];
              filePath = sourceFile.path.replace(
                `/${input.source_lang}`,
                `/${lang}`
              );
              filePath = filePath.replace(
                `${input.source_lang}.json`,
                `${lang}.json`
              );
            }

            // Validate path is within project directory (prevent path traversal)
            const resolvedPath = resolve(filePath);
            if (!isPathWithinProject(resolvedPath, projectPath)) {
              results.push({
                language: lang,
                translated_count: result.translatedCount,
                file_written: null, // Skipped: path outside project
              });
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
            const newTranslations = unflattenJson(result.translations);

            // Deep merge: new translations override existing ones
            let mergedContent = deepMerge(existingContent, newTranslations);

            // Remove any keys in target that don't exist in source
            mergedContent = removeExtraKeys(mergedContent, sourceKeys);

            // Ensure directory exists
            await mkdir(dirname(resolvedPath), { recursive: true });

            // Write file with format preservation
            const fileContent = stringifyWithFormat(mergedContent, sourceFormat);
            await writeFile(resolvedPath, fileContent, "utf-8");

            results.push({
              language: lang,
              translated_count: result.translatedCount,
              file_written: resolvedPath,
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
