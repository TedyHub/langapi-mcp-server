/**
 * list_local_locales MCP Tool
 * Scans project for locale files (JSON, ARB, .strings, .xcstrings, .stringsdict) and detects i18n framework
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectLocales } from "../locale-detection/index.js";

// Input schema
const ListLocalLocalesSchema = z.object({
  project_path: z
    .string()
    .optional()
    .describe(
      "Root path of the project to scan. Defaults to current working directory."
    ),
  include_key_count: z
    .boolean()
    .default(true)
    .describe("Whether to count keys in each locale file"),
});

export type ListLocalLocalesInput = z.infer<typeof ListLocalLocalesSchema>;

// Output type
export interface ListLocalLocalesOutput {
  framework: string;
  confidence: "high" | "medium" | "low";
  source_lang: string | null;
  locales_path: string | null;
  locales: Array<{
    lang: string;
    files: Array<{
      path: string;
      namespace: string | null;
      key_count: number;
    }>;
    total_keys: number;
  }>;
  config_file: string | null;
}

/**
 * Register the list_local_locales tool with the MCP server
 */
export function registerListLocalLocales(server: McpServer): void {
  server.tool(
    "list_local_locales",
    "Scan project for locale files (JSON, ARB, .strings, .xcstrings, .stringsdict), detect i18n framework (next-intl, i18next, react-intl, flutter, ios-macos, generic), and return structured information about available translations.",
    ListLocalLocalesSchema.shape,
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const input = ListLocalLocalesSchema.parse(args);
      const projectPath = input.project_path || process.cwd();

      const result = await detectLocales(projectPath, input.include_key_count);

      const output: ListLocalLocalesOutput = {
        framework: result.framework,
        confidence: result.confidence,
        source_lang: result.sourceLang,
        locales_path: result.localesPath,
        locales: result.locales.map((locale) => ({
          lang: locale.lang,
          files: locale.files.map((file) => ({
            path: file.relativePath,
            namespace: file.namespace,
            key_count: file.keyCount,
          })),
          total_keys: locale.totalKeys,
        })),
        config_file: result.configFile,
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
