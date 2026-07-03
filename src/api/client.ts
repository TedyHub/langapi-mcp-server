/**
 * LangAPI client for making API requests
 */

import { API_BASE_URL } from "../config/env.js";
import { getAuthToken, hasAnyCredentials, forceRefreshAuthToken } from "../auth/token-provider.js";
import type { TranslateFileRequest, TranslateFileResponse, AccountStatusResult } from "./types.js";

/** Default request timeout in milliseconds (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30000;

function isTranslateFileResponse(data: unknown): data is TranslateFileResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.success !== true) return false;
  return typeof obj.delta === "object" && obj.delta !== null && typeof obj.cost === "object" && obj.cost !== null;
}

export class LangAPIClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(
    apiKey: string,
    baseUrl: string = API_BASE_URL,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create a client instance, resolving a bearer token from either the
   * static LANGAPI_API_KEY env var or a browser-login session (auto-
   * refreshed if needed).
   * @throws Error if no credentials are configured at all
   */
  static async create(): Promise<LangAPIClient> {
    const token = await getAuthToken();
    if (!token) {
      throw new Error(
        "Not authenticated. Run `npx @langapi/mcp-server login`, or set the LANGAPI_API_KEY environment variable for CI."
      );
    }
    return new LangAPIClient(token);
  }

  /**
   * Cheap synchronous check for "is some credential configured at all" —
   * does not validate or refresh anything.
   */
  static canCreate(): boolean {
    return hasAnyCredentials();
  }

  /**
   * Translate a whole locale file. The server parses both the current
   * source file and the previous translation (if provided), diffs via its
   * hash cache, translates only what changed, and returns a ready-to-write
   * file in the original format — this client does no comparison itself.
   */
  async translateFile(request: TranslateFileRequest): Promise<TranslateFileResponse> {
    const first = await this.sendTranslateFile(request);

    // Transparently recover from an expired browser-login token: when the
    // server reports TOKEN_EXPIRED, refresh the session once, persist the
    // rotated credentials, and retry the original request exactly once. We
    // retry only on that explicit signal and only when a refresh actually
    // yields a new token (a static API key or a missing refresh token returns
    // null, so we surface the auth error instead of looping).
    if (first.success === false && first.error.code === "TOKEN_EXPIRED") {
      const newToken = await forceRefreshAuthToken();
      if (newToken) {
        this.apiKey = newToken;
        return this.sendTranslateFile(request);
      }
    }

    return first;
  }

  /**
   * Fetch the current account status (credit balance + subscription plan) so
   * an agent has parity with the dashboard without running a dry-run sync.
   * Uses the same refresh-and-single-retry recovery as translateFile.
   */
  async getAccountStatus(): Promise<AccountStatusResult> {
    const first = await this.sendGetAccountStatus();
    if (first.success === false && first.error.code === "TOKEN_EXPIRED") {
      const newToken = await forceRefreshAuthToken();
      if (newToken) {
        this.apiKey = newToken;
        return this.sendGetAccountStatus();
      }
    }
    return first;
  }

  private async sendGetAccountStatus(): Promise<AccountStatusResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/account`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        const errorObj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
        const errorData =
          typeof errorObj.error === "object" && errorObj.error !== null
            ? (errorObj.error as Record<string, unknown>)
            : {};
        return {
          success: false,
          error: {
            code: typeof errorData.code === "string" ? errorData.code : "API_ERROR",
            message: typeof errorData.message === "string" ? errorData.message : `HTTP ${response.status}`,
          },
        };
      }

      const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
      if (obj.success === true && typeof obj.account === "object" && obj.account !== null) {
        return data as AccountStatusResult;
      }
      return { success: false, error: { code: "INVALID_RESPONSE", message: "API returned an unexpected response format" } };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false, error: { code: "TIMEOUT", message: `Request timed out after ${this.timeoutMs}ms` } };
      }
      return {
        success: false,
        error: { code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Unknown network error" },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Performs a single translate-file request with the current bearer token. */
  private async sendTranslateFile(request: TranslateFileRequest): Promise<TranslateFileResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/translate-file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        const errorObj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
        const errorData =
          typeof errorObj.error === "object" && errorObj.error !== null
            ? (errorObj.error as Record<string, unknown>)
            : {};

        return {
          success: false,
          error: {
            code: typeof errorData.code === "string" ? errorData.code : "API_ERROR",
            message: typeof errorData.message === "string" ? errorData.message : `HTTP ${response.status}`,
            currentBalance: typeof errorData.currentBalance === "number" ? errorData.currentBalance : undefined,
            requiredCredits: typeof errorData.requiredCredits === "number" ? errorData.requiredCredits : undefined,
          },
        };
      }

      if (isTranslateFileResponse(data)) {
        return data;
      }

      return {
        success: false,
        error: { code: "INVALID_RESPONSE", message: "API returned an unexpected response format" },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { success: false, error: { code: "TIMEOUT", message: `Request timed out after ${this.timeoutMs}ms` } };
      }
      return {
        success: false,
        error: { code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Unknown network error" },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
