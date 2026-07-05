/**
 * sync_translations MCP Tool
 *
 * Thin client over LangAPI's /v1/translate-file endpoint. For each source
 * file and target language, this tool reads the current source file and
 * the existing translation (if any) and sends both to the server as-is.
 * All comparison, format parsing, and merging happens server-side — this
 * tool never inspects file content beyond reading/writing raw bytes.
 */

import { z } from "zod";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { dirname, resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales } from "../locale-detection/index.js";
import { isArbFile, getLocaleFileExtension } from "../utils/arb-parser.js";
import {
  detectAppleFileType,
  isXCStringsFile,
  computeAppleLprojTargetPath,
} from "../utils/apple-common.js";
import { LangAPIClient } from "../api/client.js";
import { delay } from "../utils/delay.js";
import { loadGlossary, glossaryTermsForLanguage, type Glossary } from "../utils/glossary.js";
import { hasAnyCredentials } from "../auth/token-provider.js";
import {
  languageCodeSchema,
  languageCodesArraySchema,
  isPathWithinProject,
} from "../utils/validation.js";
import type { FileFormat, TranslateFileChangeSummary } from "../api/types.js";

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. rename() is atomic on the same filesystem, so a concurrent sync (or a
 * crash mid-write) never observes a half-written or truncated localization file
 * (finding #32). Last writer wins, but every observable state is a complete file.
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
}

const SyncTranslationsSchema = z.object({
  source_lang: languageCodeSchema.describe("Source language code (e.g., 'en', 'pt-BR')"),
  target_langs: languageCodesArraySchema.describe(
    "Target language codes to translate to. Can include NEW languages not yet in the project (e.g., ['cs', 'de'] to add Czech and German)"
  ),
  dry_run: z
    .boolean()
    .default(true)
    .describe("If true, only preview changes without syncing. Default: true (safe mode)"),
  project_path: z
    .string()
    .optional()
    .describe("Root path of the project. Defaults to current working directory."),
  write_to_files: z
    .boolean()
    .default(true)
    .describe("If true, write translated content back to local files"),
  glossary_file: z
    .string()
    .optional()
    .describe(
      "Path to a glossary file (CSV with source_term/language/target_term columns, or structured JSON with doNotTranslate + terms). Terms relevant to each target language are attached to that language's request so brand names and domain terms translate consistently. Unverified languages are left untouched."
    ),
});

export type SyncTranslationsInput = z.infer<typeof SyncTranslationsSchema>;

interface PerLanguageResult {
  language: string;
  file: string;
  delta: TranslateFileChangeSummary;
  wordsToTranslate?: number;
  creditsRequired?: number;
  fileWritten?: string | null;
  qaWarnings?: number;
}

interface SyncPreviewOutput {
  success: true;
  dry_run: true;
  summary: {
    new_keys: number;
    changed_keys: number;
    removed_keys: number;
    reused_from_cache: number;
    words_to_translate: number;
    credits_required: number;
    current_balance: number;
    balance_after_sync: number;
    unlimited_plan?: boolean;
  };
  per_language: Array<{
    language: string;
    file: string;
    new_keys: number;
    changed_keys: number;
    removed_keys: number;
    reused_from_cache: number;
  }>;
  message: string;
}

interface SyncExecuteOutput {
  success: true;
  dry_run: false;
  results: Array<{
    language: string;
    file_written: string | null;
    new_keys: number;
    changed_keys: number;
    removed_keys: number;
    reused_from_cache: number;
    qa_warnings?: number;
  }>;
  cost: {
    credits_used: number;
    balance_after_sync: number;
    unlimited_plan?: boolean;
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
  };
  /**
   * (file, language) pairs that already succeeded — and, if dry_run was
   * false, were already billed and written to disk — before this failure.
   * Present so the caller doesn't blindly retry and double-bill/re-translate
   * work that's already done.
   */
  partial_results?: Array<{
    language: string;
    file: string;
    file_written: string | null;
  }>;
}

type SyncOutput = SyncPreviewOutput | SyncExecuteOutput | SyncErrorOutput;

function textResult(output: SyncOutput) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
}

function detectFileFormat(filePath: string): FileFormat {
  const appleType = detectAppleFileType(filePath);
  if (appleType) return appleType;
  if (isArbFile(filePath)) return "arb";
  return "json";
}

/**
 * Compute target file path by replacing source language with target language.
 * Handles directory-based (locales/en/file.json), flat (locales/en.json),
 * Flutter underscore (app_en.arb), and iOS/macOS .lproj naming. Pure path
 * math — no file content is read here.
 */
function computeTargetFilePath(sourcePath: string, sourceLang: string, targetLang: string): string | null {
  const ext = getLocaleFileExtension(sourcePath);

  const lprojPath = computeAppleLprojTargetPath(sourcePath, sourceLang, targetLang);
  if (lprojPath) return lprojPath;

  // xcstrings files hold every language in one file — same path for all targets.
  if (isXCStringsFile(sourcePath)) return sourcePath;

  const dirPattern = `/${sourceLang}/`;
  if (sourcePath.includes(dirPattern)) {
    return sourcePath.replace(dirPattern, `/${targetLang}/`);
  }

  const filePattern = `/${sourceLang}${ext}`;
  if (sourcePath.endsWith(filePattern)) {
    return sourcePath.slice(0, -filePattern.length) + `/${targetLang}${ext}`;
  }

  const prefixPattern = `.${sourceLang}${ext}`;
  if (sourcePath.endsWith(prefixPattern)) {
    return sourcePath.slice(0, -prefixPattern.length) + `.${targetLang}${ext}`;
  }

  const underscorePattern = `_${sourceLang}${ext}`;
  if (sourcePath.endsWith(underscorePattern)) {
    return sourcePath.slice(0, -underscorePattern.length) + `_${targetLang}${ext}`;
  }

  return null;
}

/**
 * Register the sync_translations tool with the MCP server
 */
export function registerSyncTranslations(server: McpServer): void {
  server.tool(
    "sync_translations",
    "Add new languages or sync existing translations via LangAPI. The server compares each file's current content against its previous translation and only translates what's new or changed. Default is dry_run=true for preview.",
    SyncTranslationsSchema.shape,
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const input = SyncTranslationsSchema.parse(args);
      const projectPath = input.project_path || process.cwd();

      if (!hasAnyCredentials()) {
        return textResult({
          success: false,
          error: {
            code: "NO_API_KEY",
            message: "Not authenticated. Run `npx @langapi/mcp-server login`, or set the LANGAPI_API_KEY environment variable for CI.",
          },
        });
      }

      // Load the project glossary once (if provided). Failing to read/parse it
      // is a hard error — silently translating without it would defeat the point.
      let glossary: Glossary | undefined;
      if (input.glossary_file) {
        try {
          glossary = await loadGlossary(resolve(input.glossary_file));
        } catch (err) {
          return textResult({
            success: false,
            error: {
              code: "GLOSSARY_ERROR",
              message: `Could not read glossary file '${input.glossary_file}': ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
      }

      const detection = await detectLocales(projectPath, false);
      const sourceLocale = detection.locales.find((l) => l.lang === input.source_lang);
      if (!sourceLocale) {
        return textResult({
          success: false,
          error: {
            code: "SOURCE_NOT_FOUND",
            message: `Source language '${input.source_lang}' not found in project`,
          },
        });
      }

      const client = await LangAPIClient.create();
      const perLanguageResults: PerLanguageResult[] = [];
      let totalCreditsUsed = 0;
      let currentBalance = 0;
      let unlimitedPlan: boolean | undefined;
      let isFirstCall = true;

      for (const file of sourceLocale.files) {
        const fileFormat = detectFileFormat(file.path);
        const sourceFileContent = await readFile(file.path, "utf-8");

        // Single-file formats (xcstrings) keep every language in one physical
        // file. We must thread the merged result of each target language into
        // the next iteration, otherwise each language merges into the stale
        // original and overwrites the previous language's output (finding #4).
        let sameFileAccumulated = sourceFileContent;

        for (const targetLang of input.target_langs) {
          const targetFilePath = computeTargetFilePath(file.path, input.source_lang, targetLang);
          if (!targetFilePath) continue;

          const isSameFile = targetFilePath === file.path;
          const resolvedTargetPath = resolve(targetFilePath);
          if (!isSameFile && !isPathWithinProject(resolvedTargetPath, projectPath)) continue;

          let previousTargetFileContent: string | undefined;
          if (isSameFile) {
            // For xcstrings the "previous target" is the same physical file,
            // accumulated across earlier target languages in this run so the
            // server merges each new language into a file that already
            // contains the ones translated before it.
            previousTargetFileContent = sameFileAccumulated;
          } else {
            try {
              previousTargetFileContent = await readFile(resolvedTargetPath, "utf-8");
            } catch {
              // No existing translation yet — fine, everything is "new" to the server.
            }
          }

          if (!isFirstCall) await delay(300);
          isFirstCall = false;

          const glossaryTerms = glossary ? glossaryTermsForLanguage(glossary, targetLang) : undefined;

          const response = await client.translateFile({
            source_lang: input.source_lang,
            target_lang: targetLang,
            file_format: fileFormat,
            source_file_content: sourceFileContent,
            previous_target_file_content: previousTargetFileContent,
            glossary: glossaryTerms && glossaryTerms.length ? glossaryTerms : undefined,
            dry_run: input.dry_run,
          });

          if (!response.success) {
            return textResult({
              success: false,
              error: {
                code: response.error.code,
                message: response.error.message,
                current_balance: response.error.currentBalance,
                required_credits: response.error.requiredCredits,
              },
              partial_results: perLanguageResults.length
                ? perLanguageResults.map((r) => ({
                    language: r.language,
                    file: r.file,
                    file_written: r.fileWritten ?? null,
                  }))
                : undefined,
            });
          }

          if ("translated_file_content" in response) {
            totalCreditsUsed += response.cost.creditsUsed;
            currentBalance = response.cost.balanceAfterSync;
            unlimitedPlan = response.cost.unlimitedPlan;

            // Thread the merged file forward so the next target language for a
            // single-file format builds on this one instead of the stale
            // original (finding #4). Done regardless of write_to_files so the
            // in-memory accumulation stays coherent for preview runs too.
            if (isSameFile) {
              sameFileAccumulated = response.translated_file_content;
            }

            let fileWritten: string | null = null;
            if (input.write_to_files) {
              const writePath = isSameFile ? file.path : resolvedTargetPath;
              await mkdir(dirname(writePath), { recursive: true });
              await atomicWriteFile(writePath, response.translated_file_content);
              fileWritten = writePath;
            }

            perLanguageResults.push({
              language: targetLang,
              file: file.relativePath,
              delta: response.delta,
              fileWritten,
              qaWarnings: response.qaWarnings,
            });
          } else {
            totalCreditsUsed += response.cost.creditsRequired;
            currentBalance = response.cost.currentBalance;
            unlimitedPlan = response.cost.unlimitedPlan;

            perLanguageResults.push({
              language: targetLang,
              file: file.relativePath,
              delta: response.delta,
              wordsToTranslate: response.cost.wordsToTranslate,
              creditsRequired: response.cost.creditsRequired,
            });
          }
        }
      }

      if (input.dry_run) {
        const totalWordsToTranslate = perLanguageResults.reduce((sum, r) => sum + (r.wordsToTranslate ?? 0), 0);
        const output: SyncPreviewOutput = {
          success: true,
          dry_run: true,
          summary: {
            new_keys: sumDelta(perLanguageResults, "newKeys"),
            changed_keys: sumDelta(perLanguageResults, "changedKeys"),
            removed_keys: sumDelta(perLanguageResults, "removedKeys"),
            reused_from_cache: perLanguageResults.reduce((sum, r) => sum + r.delta.reusedFromCacheCount, 0),
            words_to_translate: totalWordsToTranslate,
            credits_required: totalCreditsUsed,
            current_balance: currentBalance,
            balance_after_sync: unlimitedPlan ? currentBalance : currentBalance - totalCreditsUsed,
            unlimited_plan: unlimitedPlan,
          },
          per_language: perLanguageResults.map((r) => ({
            language: r.language,
            file: r.file,
            new_keys: r.delta.newKeys.length,
            changed_keys: r.delta.changedKeys.length,
            removed_keys: r.delta.removedKeys.length,
            reused_from_cache: r.delta.reusedFromCacheCount,
          })),
          message: `Preview: ${totalWordsToTranslate} words to translate across ${new Set(perLanguageResults.map((r) => r.language)).size} language(s), ${totalCreditsUsed} credits required. Run with dry_run=false to execute.`,
        };
        return textResult(output);
      }

      const output: SyncExecuteOutput = {
        success: true,
        dry_run: false,
        results: perLanguageResults.map((r) => ({
          language: r.language,
          file_written: r.fileWritten ?? null,
          new_keys: r.delta.newKeys.length,
          changed_keys: r.delta.changedKeys.length,
          removed_keys: r.delta.removedKeys.length,
          reused_from_cache: r.delta.reusedFromCacheCount,
          qa_warnings: r.qaWarnings,
        })),
        cost: {
          credits_used: totalCreditsUsed,
          balance_after_sync: currentBalance,
          unlimited_plan: unlimitedPlan,
        },
        message: `Sync complete across ${new Set(perLanguageResults.map((r) => r.language)).size} language(s).`,
      };
      return textResult(output);
    }
  );
}

function sumDelta(results: PerLanguageResult[], key: "newKeys" | "changedKeys" | "removedKeys"): number {
  return results.reduce((sum, r) => sum + r.delta[key].length, 0);
}

// Export helpers for testing
export { computeTargetFilePath, detectFileFormat };
