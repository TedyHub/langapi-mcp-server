/**
 * Environment variable configuration for LangAPI MCP Server.
 *
 * Authentication is browser/device login only — there is no static API key.
 * `LANGAPI_API_URL` is an escape hatch for pointing the CLI at a non-prod API.
 */

export const API_BASE_URL =
  process.env.LANGAPI_API_URL || "https://api.langapi.io";
