/**
 * manage_glossary MCP Tool
 *
 * Agent-native parity with the dashboard's Glossary view (finding #53): list,
 * add, and delete glossary terms that force specific translations for brand
 * names, product terms, or jargon. Terms are scoped to the authenticated
 * tenant and applied automatically on every sync for the matching language
 * pair. Backed by LangAPI's tenant-scoped /api/v1/glossary endpoints.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LangAPIClient } from "../api/client.js";

const ManageGlossarySchema = z.object({
  action: z
    .enum(["list", "add", "delete"])
    .describe("What to do: 'list' existing terms, 'add' a new term, or 'delete' a term by id."),
  source_lang: z
    .string()
    .optional()
    .describe("Source language code (e.g. 'en'). Required for 'add'; optional filter for 'list'."),
  target_lang: z
    .string()
    .optional()
    .describe("Target language code (e.g. 'de'). Required for 'add'; optional filter for 'list'."),
  source_text: z.string().optional().describe("The source term to match. Required for 'add'."),
  target_text: z
    .string()
    .optional()
    .describe("The translation the source term must map to. Required for 'add'."),
  case_sensitive: z
    .boolean()
    .optional()
    .describe("Whether matching is case-sensitive. Defaults to false. Used by 'add'."),
  id: z.string().optional().describe("Glossary term id. Required for 'delete'."),
});

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function registerManageGlossary(server: McpServer): void {
  server.tool(
    "manage_glossary",
    "Manage the LangAPI translation glossary (terms that force specific translations for brand names, product terms, or jargon). Actions: 'list' (optionally filtered by source_lang+target_lang), 'add' (needs source_lang, target_lang, source_text, target_text), 'delete' (needs id). Terms apply automatically on every sync_translations run.",
    ManageGlossarySchema.shape,
    async (input): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      if (!LangAPIClient.canCreate()) {
        return textResult({
          success: false,
          error: {
            code: "NOT_AUTHENTICATED",
            message: "Not authenticated. Run `npx @langapi/mcp-server login`, or set LANGAPI_API_KEY for CI.",
          },
        });
      }

      const client = await LangAPIClient.create();

      if (input.action === "list") {
        const result = await client.listGlossary(input.source_lang, input.target_lang);
        if (!result.success) return textResult({ success: false, error: result.error });
        return textResult({
          success: true,
          terms: result.data.map((t) => ({
            id: t._id,
            source_lang: t.sourceLang,
            source_text: t.sourceText,
            target_lang: t.targetLang,
            target_text: t.targetText,
            case_sensitive: t.caseSensitive,
          })),
        });
      }

      if (input.action === "add") {
        if (!input.source_lang || !input.target_lang || !input.source_text || !input.target_text) {
          return textResult({
            success: false,
            error: {
              code: "MISSING_FIELDS",
              message: "'add' requires source_lang, target_lang, source_text, and target_text.",
            },
          });
        }
        const result = await client.addGlossaryTerm({
          sourceLang: input.source_lang,
          targetLang: input.target_lang,
          sourceText: input.source_text,
          targetText: input.target_text,
          caseSensitive: input.case_sensitive,
        });
        if (!result.success) return textResult({ success: false, error: result.error });
        return textResult({
          success: true,
          term: {
            id: result.data._id,
            source_lang: result.data.sourceLang,
            source_text: result.data.sourceText,
            target_lang: result.data.targetLang,
            target_text: result.data.targetText,
            case_sensitive: result.data.caseSensitive,
          },
        });
      }

      // action === "delete"
      if (!input.id) {
        return textResult({
          success: false,
          error: { code: "MISSING_FIELDS", message: "'delete' requires an id (get it from action:'list')." },
        });
      }
      const result = await client.deleteGlossaryTerm(input.id);
      if (!result.success) return textResult({ success: false, error: result.error });
      return textResult({ success: true, deleted_id: input.id });
    }
  );
}
