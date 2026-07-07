/**
 * Device-authorization login (`npx @langapi/mcp-server login`), the
 * `gh auth login`-style flow that replaces copy-pasting a static API key.
 * Runs as a one-off CLI command, not an MCP tool.
 *
 * Uses the OAuth 2.0 Device Authorization Grant (RFC 8628): we ask the server
 * for a short user code + verification URL, show them (and open a browser),
 * then poll the token endpoint until the user approves in their browser. There
 * is no localhost callback server — nothing listens on 127.0.0.1 — so a web
 * login is never left stranded on a dead loopback URL.
 */

import { API_BASE_URL } from "../config/env.js";
import { writeCredentials } from "./credentials-store.js";
import { logout as revokeAndClear } from "./token-provider.js";
import { openBrowser } from "./browser.js";
import { isValidTokenResponse } from "./token-response.js";
import { delay } from "../utils/delay.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

function isDeviceAuthResponse(data: unknown): data is DeviceAuthResponse {
  if (typeof data !== "object" || data === null) return false;
  const o = data as Record<string, unknown>;
  return (
    typeof o.device_code === "string" &&
    o.device_code.length > 0 &&
    typeof o.user_code === "string" &&
    o.user_code.length > 0 &&
    typeof o.verification_uri === "string" &&
    o.verification_uri.length > 0 &&
    typeof o.expires_in === "number" &&
    Number.isFinite(o.expires_in) &&
    o.expires_in > 0 &&
    typeof o.interval === "number" &&
    Number.isFinite(o.interval) &&
    o.interval > 0
  );
}

/** Read `error.code` from the server's `{ success:false, error:{ code } }` envelope. */
function errorCode(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const err = (data as Record<string, unknown>).error;
  if (typeof err !== "object" || err === null) return null;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function requestDeviceCode(): Promise<DeviceAuthResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to start login (HTTP ${response.status}). Please try again.`);
  }
  const data: unknown = await response.json();
  if (!isDeviceAuthResponse(data)) {
    throw new Error("Received an invalid device-authorization response from the server.");
  }
  return data;
}

/**
 * Poll POST /oauth/token with the device grant until the user approves, denies,
 * or the code expires. Honors the server's `interval` and backs off on SLOW_DOWN.
 */
async function pollForToken(device: DeviceAuthResponse): Promise<void> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = device.interval * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("Login timed out. Run `npx @langapi/mcp-server login` again for a new code.");
    }

    await delay(intervalMs);

    const response = await fetch(`${API_BASE_URL}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: device.device_code }),
    });
    const data: unknown = await response.json().catch(() => null);

    if (response.ok) {
      if (!isValidTokenResponse(data)) {
        throw new Error("Received an invalid token response from the server.");
      }
      await writeCredentials({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      });
      return;
    }

    switch (errorCode(data)) {
      case "AUTHORIZATION_PENDING":
        break; // keep waiting
      case "SLOW_DOWN":
        intervalMs += 5000; // RFC 8628: back off by 5s
        break;
      case "ACCESS_DENIED":
        throw new Error("Login was denied. Nothing was granted.");
      case "EXPIRED_TOKEN":
        throw new Error("The login code expired. Run `npx @langapi/mcp-server login` again.");
      default:
        throw new Error(`Login failed (HTTP ${response.status}).`);
    }
  }
}

export async function runLogin(): Promise<void> {
  const device = await requestDeviceCode();
  const openUrl = device.verification_uri_complete ?? device.verification_uri;

  console.log("\nTo sign in, open this page in your browser:");
  console.log(`  ${device.verification_uri}`);
  console.log(`\nand enter the code:  ${device.user_code}\n`);
  console.log("Opening your browser...");
  openBrowser(openUrl);
  console.log("Waiting for you to approve in the browser...\n");

  await pollForToken(device);

  console.log("Logged in successfully. Credentials saved to ~/.langapi/credentials.json");
}

export async function runLogout(): Promise<void> {
  await revokeAndClear();
  console.log("Logged out. Local credentials cleared.");
}
