/**
 * MCP Server setup for LangAPI
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListLocalLocales } from "./tools/list-local-locales.js";
import { registerGetTranslationStatus } from "./tools/get-translation-status.js";
import { registerSyncTranslations } from "./tools/sync-translations.js";
import { registerGetDiff } from "./tools/get-diff.js";

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
  registerGetDiff(server);

  return server;
}
