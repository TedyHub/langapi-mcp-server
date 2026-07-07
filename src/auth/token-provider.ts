/**
 * Resolves the bearer token used for API calls. The only credential is the
 * browser/device-login session token, auto-refreshed when it's expired or
 * close to expiring.
 */

import { API_BASE_URL } from "../config/env.js";
import {
  readCredentials,
  writeCredentials,
  clearCredentials,
  credentialsFileExists,
  type StoredCredentials,
} from "./credentials-store.js";
import { isValidTokenResponse } from "./token-response.js";

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export function hasAnyCredentials(): boolean {
  return credentialsFileExists();
}

async function refreshAccessToken(creds: StoredCredentials): Promise<StoredCredentials | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/oauth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: creds.refresh_token }),
    });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (!isValidTokenResponse(data)) return null;

    const updated: StoredCredentials = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await writeCredentials(updated);
    return updated;
  } catch {
    return null;
  }
}

/**
 * Get a valid bearer token, refreshing the browser-login session if needed.
 * Returns null if no credentials are configured at all.
 */
export async function getAuthToken(): Promise<string | null> {
  const creds = await readCredentials();
  if (!creds) return null;

  if (Date.now() < creds.expires_at - EXPIRY_SAFETY_MARGIN_MS) {
    return creds.access_token;
  }

  const refreshed = await refreshAccessToken(creds);
  return refreshed?.access_token ?? null;
}

/**
 * Force a refresh of the browser-login session token, persisting the rotated
 * credentials, and return the new access token. Returns null when a refresh
 * isn't possible — there are no stored credentials, or the refresh request
 * itself failed.
 *
 * Used by the API client to transparently recover from a mid-request
 * TOKEN_EXPIRED 401 without re-running `create()`.
 */
export async function forceRefreshAuthToken(): Promise<string | null> {
  const creds = await readCredentials();
  if (!creds) return null;

  const refreshed = await refreshAccessToken(creds);
  return refreshed?.access_token ?? null;
}

/**
 * Revoke the current session server-side (best-effort) and clear local
 * credentials. Used by `langapi-mcp logout`.
 */
export async function logout(): Promise<void> {
  const creds = await readCredentials();
  if (creds) {
    try {
      await fetch(`${API_BASE_URL}/api/v1/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      });
    } catch {
      // Best-effort server-side revoke — still clear local credentials below.
    }
  }
  await clearCredentials();
}
