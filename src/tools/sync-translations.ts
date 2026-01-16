/**
 * sync_translations MCP Tool
 * Sync translations via LangAPI /v1/sync endpoint
 */

import { z } from "zod";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales, type LocaleFile } from "../locale-detection/index.js";
import {
  flattenJson,
  unflattenJson,
  parseJsonSafe,
} from "../utils/json-parser.js";
import {
  isArbFile,
  parseArbContent,
  mergeArbContent,
  getLocaleFileExtension,
} from "../utils/arb-parser.js";
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
  detectAppleFileType,
  isXCStringsFile,
  computeAppleLprojTargetPath,
  type AppleFileType,
} from "../utils/apple-common.js";
import {
  parseStringsContent,
  mergeStringsContent,
  type StringsContent,
} from "../utils/strings-parser.js";
import { type XCStringsFile } from "../utils/xcstrings-parser.js";
import {
  parseXCStringsSource,
  xcstringsHasMissingKeys,
  getXCStringsContentToSync,
  writeXCStringsTranslations,
} from "../handlers/xcstrings-sync-handler.js";
import {
  parseStringsDictContent,
  flattenStringsDictForApi,
  mergeStringsDictContent,
  type StringsDictEntry,
} from "../utils/stringsdict-parser.js";

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
  hard_sync: z
    .boolean()
    .default(false)
    .describe(
      "If true, re-translate all changed keys even if target already has translations. If false (default), only translate keys missing in target."
    ),
  precision: z
    .enum(["standard", "extra"])
    .default("standard")
    .describe(
      "Translation precision level. 'standard' uses 1 credit/word. 'extra' provides more precise translation at 2 credits/word."
    ),
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
 * Also supports Flutter ARB files with underscore naming (app_en.arb → app_ko.arb).
 * Also supports iOS/macOS .lproj directories (en.lproj/Localizable.strings → de.lproj/Localizable.strings).
 */
function computeTargetFilePath(
  sourcePath: string,
  sourceLang: string,
  targetLang: string
): string | null {
  const ext = getLocaleFileExtension(sourcePath);

  // Try iOS/macOS .lproj directory pattern first
  const lprojPath = computeAppleLprojTargetPath(sourcePath, sourceLang, targetLang);
  if (lprojPath) {
    return lprojPath;
  }

  // xcstrings files contain all languages in one file - return same path
  // (will be handled specially in the write logic)
  if (isXCStringsFile(sourcePath)) {
    return sourcePath;
  }

  // Try directory-based replacement first: /en/ → /ko/
  const dirPattern = `/${sourceLang}/`;
  if (sourcePath.includes(dirPattern)) {
    return sourcePath.replace(dirPattern, `/${targetLang}/`);
  }

  // Try flat file replacement: /en.json → /ko.json or /en.arb → /ko.arb
  const filePattern = `/${sourceLang}${ext}`;
  if (sourcePath.endsWith(filePattern)) {
    return sourcePath.slice(0, -filePattern.length) + `/${targetLang}${ext}`;
  }

  // Try filename with prefix: messages.en.json → messages.ko.json
  const prefixPattern = `.${sourceLang}${ext}`;
  if (sourcePath.endsWith(prefixPattern)) {
    return sourcePath.slice(0, -prefixPattern.length) + `.${targetLang}${ext}`;
  }

  // Try Flutter-style underscore pattern: app_en.arb → app_ko.arb
  const underscorePattern = `_${sourceLang}${ext}`;
  if (sourcePath.endsWith(underscorePattern)) {
    return sourcePath.slice(0, -underscorePattern.length) + `_${targetLang}${ext}`;
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
    "Add new languages or sync existing translations via LangAPI. Use this tool to: (1) ADD translations for new languages like Czech, Spanish, French - creates new locale files automatically, (2) SYNC existing translations when source content changes. Supports any valid language code (e.g., 'cs' for Czech, 'de' for German). Default is dry_run=true for preview. Use precision='extra' for more precise translations at 2 credits/word (default 'standard' is 1 credit/word).",
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
        /** ARB metadata (keys starting with @) - only populated for .arb files */
        arbMetadata?: Record<string, unknown>;
        /** Apple file type if applicable */
        appleType?: AppleFileType;
        /** Strings file parsed content - for .strings files */
        stringsContent?: StringsContent;
        /** Stringsdict entries - for .stringsdict files */
        stringsDictEntries?: StringsDictEntry[];
        /** XCStrings parsed data - for .xcstrings files */
        xcstringsData?: XCStringsFile;
      }

      const sourceFilesData: SourceFileData[] = [];

      for (const file of sourceLocale.files) {
        const content = await readFile(file.path, "utf-8");
        const appleType = detectAppleFileType(file.path);

        // Handle Apple file formats
        if (appleType === "strings") {
          const stringsContent = parseStringsContent(content);
          sourceFilesData.push({
            file,
            content: {},
            flatContent: stringsContent.entries,
            format: { indent: "  ", trailingNewline: true, keyStructure: "flat" },
            appleType: "strings",
            stringsContent,
          });
          continue;
        }

        if (appleType === "xcstrings") {
          const parsed = parseXCStringsSource(file, content);
          if (parsed) {
            sourceFilesData.push({
              file: parsed.file,
              content: {},
              flatContent: parsed.flatContent,
              format: { indent: "  ", trailingNewline: true, keyStructure: "flat" },
              appleType: "xcstrings",
              xcstringsData: parsed.xcstringsData,
            });
          }
          continue;
        }

        if (appleType === "stringsdict") {
          const stringsDictContent = parseStringsDictContent(content);
          if (stringsDictContent) {
            const flatContent = flattenStringsDictForApi(stringsDictContent.entries);
            sourceFilesData.push({
              file,
              content: {},
              flatContent,
              format: { indent: "  ", trailingNewline: true, keyStructure: "flat" },
              appleType: "stringsdict",
              stringsDictEntries: stringsDictContent.entries,
            });
          }
          continue;
        }

        // Handle JSON/ARB files
        const parsed = parseJsonWithFormat(content);
        if (parsed) {
          let flatContent: Array<{ key: string; value: string }>;
          let arbMetadata: Record<string, unknown> | undefined;

          if (isArbFile(file.path)) {
            // ARB file: extract translatable keys only, preserve metadata
            const arbContent = parseArbContent(parsed.data as Record<string, unknown>);
            flatContent = arbContent.translatableKeys;
            arbMetadata = arbContent.metadata;
          } else {
            // Regular JSON: flatten all keys
            flatContent = flattenJson(parsed.data as Record<string, unknown>);
          }

          sourceFilesData.push({
            file,
            content: parsed.data as Record<string, unknown>,
            flatContent,
            format: parsed.format,
            arbMetadata,
          });
        }
      }

      // Build merged flatContent from each file's flatContent (not from content objects)
      // This is needed because Apple formats (.strings, .xcstrings, .stringsdict)
      // store keys in flatContent, not in the content object
      let flatContent: Array<{ key: string; value: string }> = [];
      let sourceFormat: JsonFormat = { indent: "  ", trailingNewline: true, keyStructure: "nested" };

      for (const fileData of sourceFilesData) {
        flatContent = flatContent.concat(fileData.flatContent);
        sourceFormat = fileData.format;
      }

      const sourceKeys = new Set(flatContent.map((item) => item.key));

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

          // Handle xcstrings files: check for missing translations within the file
          if (sourceFileData.appleType === "xcstrings" && sourceFileData.xcstringsData) {
            const hasMissingKeys = xcstringsHasMissingKeys(
              sourceFileData.xcstringsData,
              targetLang,
              sourceFileData.flatContent
            );

            if (hasMissingKeys && !languagesWithMissingFiles.includes(targetLang)) {
              languagesWithMissingFiles.push(targetLang);
            }
            continue;
          }

          // Skip if path computation failed or would overwrite source (non-xcstrings)
          if (!targetFilePath || targetFilePath === sourceFileData.file.path) {
            continue;
          }

          // Check if file exists and has all source keys
          try {
            const targetContent = await readFile(targetFilePath, "utf-8");
            const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));
            let existingKeys = new Set<string>();

            // Use appropriate parser based on source file type
            if (sourceFileData.appleType === "strings") {
              const parsed = parseStringsContent(targetContent);
              existingKeys = new Set(
                parsed.entries.filter(e => e.value && e.value.trim() !== "").map(e => e.key)
              );
            } else if (sourceFileData.appleType === "stringsdict") {
              const parsed = parseStringsDictContent(targetContent);
              if (parsed) {
                existingKeys = new Set(parsed.entries.map(e => e.key));
              }
            } else {
              // JSON/ARB files
              const parsed = parseJsonWithFormat(targetContent);
              if (parsed) {
                const flatTarget = flattenJson(parsed.data as Record<string, unknown>);
                existingKeys = new Set(flatTarget.map((item) => item.key));
              }
            }

            const hasMissingKeys = [...sourceFileKeys].some((key) => !existingKeys.has(key));
            if (hasMissingKeys && !languagesWithMissingFiles.includes(targetLang)) {
              languagesWithMissingFiles.push(targetLang);
            }
          } catch {
            // File doesn't exist - this language has missing files
            if (!languagesWithMissingFiles.includes(targetLang)) {
              languagesWithMissingFiles.push(targetLang);
            }
          }
        }
      }

      // If no missing languages AND no languages with missing files, return early
      // (This means all target files exist and have all source keys)
      if (missingLanguages.length === 0 && languagesWithMissingFiles.length === 0) {
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

      // Track all unique keys being synced (for dry_run response)
      const allKeysToSync = new Set<string>();

      // Process each source file
      for (const sourceFileData of sourceFilesData) {
        const sourceFileKeys = new Set(sourceFileData.flatContent.map((item) => item.key));

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

          // Handle xcstrings files specially (same file for all languages)
          if (sourceFileData.appleType === "xcstrings" && sourceFileData.xcstringsData) {
            const isMissingLang = missingLanguages.includes(targetLang);
            const skipSet = getSkipKeysForLang(input.skip_keys, targetLang);

            const { contentToSync, skippedKeys } = getXCStringsContentToSync(
              { file: sourceFileData.file, flatContent: sourceFileData.flatContent, xcstringsData: sourceFileData.xcstringsData },
              targetLang,
              isMissingLang,
              skipSet,
              input.hard_sync
            );

            // Track skipped keys
            if (skippedKeys.length > 0) {
              const existing = skippedKeysReport[targetLang] || [];
              skippedKeysReport[targetLang] = [...new Set([...existing, ...skippedKeys])];
            }

            if (contentToSync.length > 0) {
              langContentMap.set(targetLang, contentToSync);
              // Track keys for dry_run response
              for (const item of contentToSync) {
                allKeysToSync.add(item.key);
              }
            }
            continue;
          }

          // Non-xcstrings files: skip if target path equals source path
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

            // Use appropriate parser based on source file type
            if (sourceFileData.appleType === "strings") {
              const parsed = parseStringsContent(targetContent);
              for (const entry of parsed.entries) {
                if (entry.value && entry.value.trim() !== "") {
                  existingTargetKeys.add(entry.key);
                }
              }
            } else if (sourceFileData.appleType === "stringsdict") {
              const parsed = parseStringsDictContent(targetContent);
              if (parsed) {
                for (const entry of parsed.entries) {
                  existingTargetKeys.add(entry.key);
                }
              }
            } else {
              // JSON or ARB files
              const parsed = parseJsonWithFormat(targetContent);
              if (parsed) {
                const flatTarget = flattenJson(parsed.data as Record<string, unknown>);
                for (const item of flatTarget) {
                  if (item.value && item.value.trim() !== "") {
                    existingTargetKeys.add(item.key);
                  }
                }
              }
            }
          } catch {
            // File doesn't exist
          }

          // Determine what content to sync
          let contentToSync: Array<{ key: string; value: string }>;

          if (input.hard_sync || isMissingLang || !targetFileExists) {
            // Hard sync, new language, or missing file: sync all keys from this source file
            contentToSync = sourceFileData.flatContent;
          } else {
            // Existing target: sync only keys missing from target
            contentToSync = sourceFileData.flatContent.filter(
              (item) => !existingTargetKeys.has(item.key)
            );
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
            // Track keys for dry_run response
            for (const item of filteredContent) {
              allKeysToSync.add(item.key);
            }
          }
        }

        // Skip API call if no languages need this file
        if (langContentMap.size === 0) {
          completedFiles.push(sourceFileData.file.path);
          continue;
        }

        // Collect all unique keys to sync for this file (union across all languages)
        const fileKeysToSync = new Set<string>();
        for (const content of langContentMap.values()) {
          for (const item of content) {
            fileKeysToSync.add(item.key);
          }
        }

        // Get source content for these keys
        const contentForApi = sourceFileData.flatContent.filter(
          (item) => fileKeysToSync.has(item.key)
        );

        if (contentForApi.length === 0) {
          completedFiles.push(sourceFileData.file.path);
          continue;
        }

        // Make API call for this file → all languages that need it
        const langsNeedingSync = Array.from(langContentMap.keys());

        const syncRequest = {
          source_lang: input.source_lang,
          target_langs: langsNeedingSync,
          content: contentForApi,
          dry_run: input.dry_run,
        };
        const response = input.precision === "extra"
          ? await client.extraSync(syncRequest)
          : await client.sync(syncRequest);

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

            // Filter translations to only keys this language actually needed
            // This prevents overwriting existing translations when syncing multiple languages
            const keysNeededForLang = langContentMap.get(targetLang);
            const keysNeededSet = keysNeededForLang
              ? new Set(keysNeededForLang.map(item => item.key))
              : new Set<string>();
            const translationsForLang = result.translations.filter(
              t => keysNeededSet.has(t.key)
            );

            // Always compute target path from source (no namespace matching!)
            const targetFilePath = computeTargetFilePath(
              sourceFileData.file.path,
              input.source_lang,
              targetLang
            );

            // For xcstrings, targetFilePath equals sourceFilePath - that's OK, handle below
            if (!targetFilePath) {
              continue;
            }
            // Skip non-xcstrings files where target equals source
            if (targetFilePath === sourceFileData.file.path && sourceFileData.appleType !== "xcstrings") {
              continue;
            }

            const resolvedPath = resolve(targetFilePath);
            if (!isPathWithinProject(resolvedPath, projectPath) && sourceFileData.appleType !== "xcstrings") {
              continue;
            }

            if (input.write_to_files) {
              // Handle Apple file formats specially
              if (sourceFileData.appleType === "strings") {
                // .strings file: merge and write
                let existingContent = "";
                try {
                  existingContent = await readFile(resolvedPath, "utf-8");
                } catch {
                  // File doesn't exist yet
                }

                const fileContent = mergeStringsContent(
                  existingContent,
                  translationsForLang,
                  sourceFileData.stringsContent?.comments || new Map(),
                  sourceFileKeys
                );

                await mkdir(dirname(resolvedPath), { recursive: true });
                await writeFile(resolvedPath, fileContent, "utf-8");

                allFilesWritten.push(resolvedPath);
                const langResult = langResults.get(targetLang)!;
                langResult.translated_count += result.translatedCount;
                langResult.files_written.push(resolvedPath);
              } else if (sourceFileData.appleType === "xcstrings" && sourceFileData.xcstringsData) {
                // .xcstrings file: update in-place (single file with all languages)
                sourceFileData.xcstringsData = await writeXCStringsTranslations(
                  sourceFileData.file.path,
                  sourceFileData.xcstringsData,
                  targetLang,
                  translationsForLang
                );

                if (!allFilesWritten.includes(sourceFileData.file.path)) {
                  allFilesWritten.push(sourceFileData.file.path);
                }
                const langResult = langResults.get(targetLang)!;
                langResult.translated_count += result.translatedCount;
                if (!langResult.files_written.includes(sourceFileData.file.path)) {
                  langResult.files_written.push(sourceFileData.file.path);
                }
              } else if (sourceFileData.appleType === "stringsdict" && sourceFileData.stringsDictEntries) {
                // .stringsdict file: merge and write
                let existingContent = "";
                try {
                  existingContent = await readFile(resolvedPath, "utf-8");
                } catch {
                  // File doesn't exist yet
                }

                const fileContent = mergeStringsDictContent(
                  existingContent,
                  translationsForLang,
                  sourceFileData.stringsDictEntries,
                  sourceFileKeys
                );

                await mkdir(dirname(resolvedPath), { recursive: true });
                await writeFile(resolvedPath, fileContent, "utf-8");

                allFilesWritten.push(resolvedPath);
                const langResult = langResults.get(targetLang)!;
                langResult.translated_count += result.translatedCount;
                langResult.files_written.push(resolvedPath);
              } else {
                // JSON or ARB files
                let mergedContent: Record<string, unknown>;

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

                if (isArbFile(resolvedPath) && sourceFileData.arbMetadata) {
                  // ARB file: merge with existing, preserve metadata, update locale
                  mergedContent = mergeArbContent(
                    existingContent,
                    translationsForLang,
                    sourceFileData.arbMetadata,
                    sourceFileKeys,
                    targetLang
                  );
                } else {
                  // Regular JSON: merge and remove extra keys
                  // Check if source uses flat keys (keys containing dots at root level)
                  if (sourceFileData.format.keyStructure === "flat") {
                    // For flat key structure, keep translations flat (don't unflatten)
                    mergedContent = { ...existingContent };
                    for (const { key, value } of translationsForLang) {
                      mergedContent[key] = value;
                    }
                    // Remove keys not in source
                    for (const key of Object.keys(mergedContent)) {
                      if (!sourceFileKeys.has(key)) {
                        delete mergedContent[key];
                      }
                    }
                  } else {
                    // For nested key structure, unflatten and deep merge
                    const newTranslations = unflattenJson(translationsForLang);
                    mergedContent = deepMerge(existingContent, newTranslations);
                    mergedContent = removeExtraKeys(mergedContent, sourceFileKeys);
                  }
                }

                // Write file
                await mkdir(dirname(resolvedPath), { recursive: true });
                const fileContent = stringifyWithFormat(mergedContent, sourceFileData.format);
                await writeFile(resolvedPath, fileContent, "utf-8");

                allFilesWritten.push(resolvedPath);

                // Update per-language results
                const langResult = langResults.get(targetLang)!;
                langResult.translated_count += result.translatedCount;
                langResult.files_written.push(resolvedPath);
              }
            } else {
              // Just track count without writing
              const langResult = langResults.get(targetLang)!;
              langResult.translated_count += result.translatedCount;
            }
          }

          completedFiles.push(sourceFileData.file.path);
        }
      }

      // Build final response
      if (input.dry_run) {
        const keysToSyncArray = Array.from(allKeysToSync);
        const output: SyncPreviewOutput = {
          success: true,
          dry_run: true,
          delta: {
            new_keys: keysToSyncArray,
            changed_keys: [],
            total_keys_to_sync: keysToSyncArray.length,
          },
          cost: {
            words_to_translate: totalWordsToTranslate,
            credits_required: totalCreditsUsed,
            current_balance: currentBalance,
            balance_after_sync: currentBalance - totalCreditsUsed,
          },
          message: `Preview: ${keysToSyncArray.length} keys to sync across ${sourceFilesData.length} file(s), ${totalCreditsUsed} credits required${input.precision === "extra" ? " (extra precision: 2 credits/word)" : ""}. Run with dry_run=false to execute.`,
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
        message: `Sync complete${input.precision === "extra" ? " (extra precision)" : ""}. ${totalTranslated} keys translated across ${input.target_langs.length} languages.${skippedMsg}`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );
}

// Export helper functions for testing
export {
  computeTargetFilePath,
  deepMerge,
  removeExtraKeys,
  removeKeysFromObject,
  getSkipKeysForLang,
};
