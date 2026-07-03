/**
 * Browser-based login flow (`npx @langapi/mcp-server login`), the
 * `gh auth login`-style alternative to copy-pasting a static API key.
 * Runs as a one-off CLI command, not an MCP tool — it opens a system
 * browser and blocks the terminal until the user approves in predklad's
 * consent page.
 */

import { createServer, type Server } from "http";
import { randomBytes } from "crypto";
import { API_BASE_URL, WEB_BASE_URL } from "../config/env.js";
import { writeCredentials } from "./credentials-store.js";
import { logout as revokeAndClear } from "./token-provider.js";
import { openBrowser } from "./browser.js";
import { isValidTokenResponse } from "./token-response.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function waitForCallback(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes. Please try again."));
    }, LOGIN_TIMEOUT_MS);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

      if (error || !returnedCode || returnedState !== state) {
        res.end("<html><body><h1>Login failed</h1><p>You can close this tab and return to your terminal.</p></body></html>");
        clearTimeout(timeout);
        server.close();
        reject(new Error(error ? `Login denied: ${error}` : "Login failed: invalid response."));
        return;
      }

      res.end("<html><body><h1>Login successful</h1><p>You can close this tab and return to your terminal.</p></body></html>");
      clearTimeout(timeout);
      server.close();
      resolve(returnedCode);
    });

    // Without this, an error emitted by the server (e.g. EACCES/EADDRNOTAVAIL
    // in a sandboxed/containerized environment) would throw an unhandled
    // exception instead of failing the login cleanly via reject().
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const authorizeUrl = new URL("/mcp/authorize", WEB_BASE_URL);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);

      console.log("Opening your browser to sign in...");
      console.log(`If it doesn't open automatically, visit:\n${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });
}

export async function runLogin(): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const code = await waitForCallback(state);

  console.log("Exchanging authorization code...");
  const response = await fetch(`${API_BASE_URL}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange authorization code (HTTP ${response.status}).`);
  }

  const data: unknown = await response.json();
  if (!isValidTokenResponse(data)) {
    throw new Error("Received an invalid token response from the server.");
  }
  await writeCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });

  console.log("Logged in successfully. Credentials saved to ~/.langapi/credentials.json");
}

export async function runLogout(): Promise<void> {
  await revokeAndClear();
  console.log("Logged out. Local credentials cleared.");
}
