/**
 * MCP Server setup for LangAPI
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListLocalLocales } from "./tools/list-local-locales.js";
import { registerGetTranslationStatus } from "./tools/get-translation-status.js";
import { registerSyncTranslations } from "./tools/sync-translations.js";
import { registerGetAccountStatus } from "./tools/get-account-status.js";
import { registerManageGlossary } from "./tools/manage-glossary.js";

/**
 * Create and configure the MCP server
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "langapi-mcp-server",
    version: "1.0.0",
  });

  // Register all tools
  registerListLocalLocales(server);
  registerGetTranslationStatus(server);
  registerSyncTranslations(server);
  registerGetAccountStatus(server);
  registerManageGlossary(server);

  return server;
}
