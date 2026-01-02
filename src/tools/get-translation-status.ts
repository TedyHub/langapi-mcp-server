/**
 * get_translation_status MCP Tool
 * Compare source locale against targets to identify missing/outdated keys
 */

import { z } from "zod";
import { readFile } from "fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales } from "../locale-detection/index.js";
import { getAllKeys, parseJsonSafe, flattenJson } from "../utils/json-parser.js";
import { LangAPIClient } from "../api/client.js";
import { languageCodeSchema } from "../utils/validation.js";

// Input schema
const GetTranslationStatusSchema = z.object({
  source_lang: languageCodeSchema.describe("Source language code (e.g., 'en', 'pt-BR')"),
  target_langs: z
    .array(languageCodeSchema)
    .optional()
    .describe(
      "Target language codes. If not provided, all detected locales except source will be used."
    ),
  project_path: z
    .string()
    .optional()
    .describe("Root path of the project. Defaults to current working directory."),
});

export type GetTranslationStatusInput = z.infer<typeof GetTranslationStatusSchema>;

// Output type
interface TargetStatus {
  lang: string;
  status: "synced" | "outdated" | "missing";
  keys: {
    total: number;
    missing: string[];
    extra: string[];
  };
}

interface CostEstimate {
  words_to_translate: number;
  credits_required: number;
  current_balance?: number;
  balance_after_sync?: number;
}

export interface GetTranslationStatusOutput {
  source_lang: string;
  source_keys: number;
  targets: TargetStatus[];
  cost_estimate: CostEstimate | null;
}

/**
 * Count words in translation values (excluding template variables)
 */
function countWords(text: string): number {
  // Remove template variables like {{name}}, {count}, %s, %d, ${var}
  const cleaned = text
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/%[sd]/g, "")
    .replace(/\$\{[^}]+\}/g, "");

  // Count words
  const words = cleaned.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

/**
 * Register the get_translation_status tool with the MCP server
 */
export function registerGetTranslationStatus(server: McpServer): void {
  server.tool(
    "get_translation_status",
    "Compare source locale against target locales to identify missing/outdated keys and estimate translation costs.",
    GetTranslationStatusSchema.shape,
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const input = GetTranslationStatusSchema.parse(args);
      const projectPath = input.project_path || process.cwd();

      // Detect locales
      const detection = await detectLocales(projectPath, true);

      // Find source locale
      const sourceLocale = detection.locales.find(
        (l) => l.lang === input.source_lang
      );
      if (!sourceLocale) {
        throw new Error(`Source language '${input.source_lang}' not found in project`);
      }

      // Read and parse source files
      const sourceContent: Record<string, unknown> = {};
      for (const file of sourceLocale.files) {
        const content = await readFile(file.path, "utf-8");
        const parsed = parseJsonSafe(content);
        if (parsed) {
          Object.assign(sourceContent, parsed);
        }
      }

      const sourceKeys = getAllKeys(sourceContent);
      const sourceKeySet = new Set(sourceKeys);

      // Determine target languages
      let targetLangs = input.target_langs;
      if (!targetLangs || targetLangs.length === 0) {
        targetLangs = detection.locales
          .filter((l) => l.lang !== input.source_lang)
          .map((l) => l.lang);
      }

      // Compare with each target
      const targets: TargetStatus[] = [];
      let totalMissingKeys: string[] = [];

      for (const targetLang of targetLangs) {
        const targetLocale = detection.locales.find((l) => l.lang === targetLang);

        if (!targetLocale) {
          // Target language doesn't exist
          targets.push({
            lang: targetLang,
            status: "missing",
            keys: {
              total: 0,
              missing: sourceKeys,
              extra: [],
            },
          });
          totalMissingKeys.push(...sourceKeys);
          continue;
        }

        // Read and parse target files
        const targetContent: Record<string, unknown> = {};
        for (const file of targetLocale.files) {
          try {
            const content = await readFile(file.path, "utf-8");
            const parsed = parseJsonSafe(content);
            if (parsed) {
              Object.assign(targetContent, parsed);
            }
          } catch {
            // Ignore read errors
          }
        }

        const targetKeys = getAllKeys(targetContent);
        const targetKeySet = new Set(targetKeys);

        // Find missing and extra keys
        const missing = sourceKeys.filter((k) => !targetKeySet.has(k));
        const extra = targetKeys.filter((k) => !sourceKeySet.has(k));

        const status: "synced" | "outdated" | "missing" =
          missing.length === 0 && extra.length === 0
            ? "synced"
            : missing.length > 0
            ? "outdated"
            : "synced";

        targets.push({
          lang: targetLang,
          status,
          keys: {
            total: targetKeys.length,
            missing,
            extra,
          },
        });

        totalMissingKeys.push(...missing);
      }

      // Estimate cost locally - calculate per-language to get accurate totals
      let costEstimate: CostEstimate | null = null;

      // Calculate words to translate by summing up per-language missing keys
      // This is more accurate than multiplying unique missing keys by language count
      const flatSource = flattenJson(sourceContent);
      const sourceKeyToWords = new Map<string, number>();
      for (const item of flatSource) {
        sourceKeyToWords.set(item.key, countWords(item.value));
      }

      // Sum words for all missing keys across all languages
      let totalWordsToTranslate = 0;
      for (const target of targets) {
        for (const missingKey of target.keys.missing) {
          const words = sourceKeyToWords.get(missingKey) || 0;
          totalWordsToTranslate += words;
        }
      }

      // credits = total words (already accounts for per-language)
      const creditsRequired = totalWordsToTranslate;

      costEstimate = {
        words_to_translate: totalWordsToTranslate,
        credits_required: creditsRequired,
      };

      // Get balance info from server if API key is configured
      if (LangAPIClient.canCreate()) {
        try {
          const client = LangAPIClient.create();
          // Only send actually missing content to get accurate API estimate
          const missingKeySet = new Set(totalMissingKeys);
          const itemsToTranslate = flatSource.filter((item) =>
            missingKeySet.has(item.key)
          );

          const response = await client.sync({
            source_lang: input.source_lang,
            target_langs: targetLangs,
            content: itemsToTranslate,
            dry_run: true,
          });

          if (response.success && "delta" in response) {
            // Use server's balance info, but keep our accurate local cost estimate
            costEstimate = {
              words_to_translate: totalWordsToTranslate,
              credits_required: creditsRequired,
              current_balance: response.cost.currentBalance,
              balance_after_sync: response.cost.currentBalance - creditsRequired,
            };
          }
        } catch {
          // Fall back to local estimate without balance info
        }
      }

      const output: GetTranslationStatusOutput = {
        source_lang: input.source_lang,
        source_keys: sourceKeys.length,
        targets,
        cost_estimate: costEstimate,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );
}
