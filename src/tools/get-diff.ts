/**
 * get_diff MCP Tool
 * Compare source locale against sync cache to identify new/changed/removed keys
 */

import { z } from "zod";
import { readFile } from "fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales } from "../locale-detection/index.js";
import { flattenJson, parseJsonSafe } from "../utils/json-parser.js";
import { languageCodeSchema } from "../utils/validation.js";
import { readSyncCache, getFullDiff, type FullDiff } from "../utils/sync-cache.js";

// Input schema
const GetDiffSchema = z.object({
  source_lang: languageCodeSchema.describe("Source language code (e.g., 'en', 'pt-BR')"),
  project_path: z
    .string()
    .optional()
    .describe("Root path of the project. Defaults to current working directory."),
});

export type GetDiffInput = z.infer<typeof GetDiffSchema>;

// Output types
interface ChangedKey {
  key: string;
  old_value: string;
  new_value: string;
}

interface DiffOutput {
  success: true;
  cache_exists: boolean;
  diff: {
    new_keys: string[];
    changed_keys: ChangedKey[];
    unchanged_keys: string[];
    removed_keys: string[];
  };
  summary: {
    total_current: number;
    total_cached: number;
    new_count: number;
    changed_count: number;
    unchanged_count: number;
    removed_count: number;
  };
  message: string;
}

interface DiffErrorOutput {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

type GetDiffOutput = DiffOutput | DiffErrorOutput;

/**
 * Register the get_diff tool with the MCP server
 */
export function registerGetDiff(server: McpServer): void {
  server.tool(
    "get_diff",
    "Compare current source locale content against the sync cache to see what's new, changed, unchanged, or removed since the last sync.",
    GetDiffSchema.shape,
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const input = GetDiffSchema.parse(args);
      const projectPath = input.project_path || process.cwd();

      // Detect locales
      const detection = await detectLocales(projectPath, false);

      // Find source locale
      const sourceLocale = detection.locales.find(
        (l) => l.lang === input.source_lang
      );
      if (!sourceLocale) {
        const output: DiffErrorOutput = {
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

      // Read and parse source files
      const sourceContent: Record<string, unknown> = {};
      for (const file of sourceLocale.files) {
        const content = await readFile(file.path, "utf-8");
        const parsed = parseJsonSafe(content);
        if (parsed) {
          Object.assign(sourceContent, parsed);
        }
      }

      // Flatten source content
      const flatContent = flattenJson(sourceContent);

      // Read cache
      const cachedContent = await readSyncCache(projectPath, input.source_lang);

      // Get full diff
      const diff: FullDiff = getFullDiff(flatContent, cachedContent);

      const totalCached = cachedContent ? Object.keys(cachedContent).length : 0;

      const output: DiffOutput = {
        success: true,
        cache_exists: cachedContent !== null,
        diff: {
          new_keys: diff.newKeys,
          changed_keys: diff.changedKeys.map((c) => ({
            key: c.key,
            old_value: c.oldValue,
            new_value: c.newValue,
          })),
          unchanged_keys: diff.unchangedKeys,
          removed_keys: diff.removedKeys,
        },
        summary: {
          total_current: flatContent.length,
          total_cached: totalCached,
          new_count: diff.newKeys.length,
          changed_count: diff.changedKeys.length,
          unchanged_count: diff.unchangedKeys.length,
          removed_count: diff.removedKeys.length,
        },
        message: cachedContent
          ? `Found ${diff.newKeys.length} new, ${diff.changedKeys.length} changed, ${diff.unchangedKeys.length} unchanged, ${diff.removedKeys.length} removed keys.`
          : `No sync cache found. All ${flatContent.length} keys will be treated as new on first sync.`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );
}
