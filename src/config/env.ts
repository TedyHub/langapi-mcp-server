/**
 * Environment variable configuration for LangAPI MCP Server
 */

export const API_BASE_URL =
  process.env.LANGAPI_API_URL || "https://api.langapi.io";

/**
 * Get the API key from environment variable
 * @returns The API key or null if not configured
 */
export function getApiKey(): string | null {
  return process.env.LANGAPI_API_KEY || null;
}

/**
 * Check if the API key is configured
 */
export function isApiKeyConfigured(): boolean {
  return !!getApiKey();
}

/**
 * Get masked API key for display (shows first 10 and last 4 chars)
 */
export function getMaskedApiKey(): string | null {
  const key = getApiKey();
  if (!key) return null;
  if (key.length <= 14) return "***";
  return `${key.slice(0, 10)}...${key.slice(-4)}`;
}
