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
 *
 * Run with `login`/`logout` as the first CLI argument (e.g.
 * `npx @langapi/mcp-server login`) to run the one-off browser-login flow
 * instead of starting the MCP stdio server — this is a human-run terminal
 * command, not something an AI assistant invokes as a tool.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runLogin, runLogout } from "./auth/login-flow.js";

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === "login") {
    await runLogin();
    return;
  }
  if (subcommand === "logout") {
    await runLogout();
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("LangAPI MCP server error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
