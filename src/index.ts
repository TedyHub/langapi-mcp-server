#!/usr/bin/env node
/**
 * LangAPI MCP Server Entry Point
 *
 * This MCP server enables AI assistants to manage i18n translations
 * in developer projects via the LangAPI service.
 *
 * Tools available:
 * - list_local_locales: Scan project for locale files
 * - get_translation_status: Compare source vs target locales
 * - sync_translations: Sync translations via LangAPI API
 * - get_diff: Compare source against sync cache for delta detection
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start LangAPI MCP server:", error);
  process.exit(1);
});
