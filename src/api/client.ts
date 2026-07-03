/**
 * LangAPI client for making API requests
 */

import { API_BASE_URL } from "../config/env.js";
import { getAuthToken, hasAnyCredentials, forceRefreshAuthToken } from "../auth/token-provider.js";
import type {
  TranslateFileRequest,
  TranslateFileResponse,
  AccountStatusResult,
  AddGlossaryTermRequest,
  GlossaryTermDto,
  GlossaryListResult,
  GlossaryAddResult,
  GlossaryDeleteResult,
} from "./types.js";

/**
 * Default request timeout in milliseconds (2 minutes). A large first-time sync
 * or new-language add translates one Qwen call per changed string at the
 * server's concurrency limit, which can legitimately exceed the old 30s cap and
 * abort a still-running (and still-billing) server job client-side (finding
 * #34). The server enforces its own per-call timeouts, so this is the outer
 * bound on a whole translate-file request.
 */
const DEFAULT_TIMEOUT_MS = 120000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isTranslateFileResponse(data: unknown): data is TranslateFileResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.success !== true) return false;
  if (typeof obj.delta !== "object" || obj.delta === null) return false;
  if (typeof obj.cost !== "object" || obj.cost === null) return false;
  const cost = obj.cost as Record<string, unknown>;

  // Execute response: the translated file must be a non-empty string and the
  // cost fields must be finite numbers, so we never write a truncated/empty
  // file to disk or accumulate NaN into the credit totals (findings #33/#39).
  if ("translated_file_content" in obj) {
    if (typeof obj.translated_file_content !== "string" || obj.translated_file_content.length === 0) {
      return false;
    }
    return isFiniteNumber(cost.creditsUsed) && isFiniteNumber(cost.balanceAfterSync);
  }

  // Dry-run estimate response: numeric estimate fields.
  return (
    isFiniteNumber(cost.wordsToTranslate) &&
    isFiniteNumber(cost.creditsRequired) &&
    isFiniteNumber(cost.balanceAfterSync)
  );
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

  /** Raw authenticated fetch with the client timeout applied. */
  private async rawFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static errorFrom(status: number, data: unknown): { code: string; message: string } {
    const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const errObj = typeof obj.error === "object" && obj.error !== null ? (obj.error as Record<string, unknown>) : {};
    return {
      code: typeof errObj.code === "string" ? errObj.code : "API_ERROR",
      message: typeof errObj.message === "string" ? errObj.message : `HTTP ${status}`,
    };
  }

  /**
   * Authenticated JSON request with the same TOKEN_EXPIRED refresh-and-retry
   * recovery as translateFile. Returns the parsed body plus status, or a
   * network/timeout error envelope.
   */
  private async authedJson(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ ok: boolean; status: number; data: unknown } | { networkError: { code: string; message: string } }> {
    try {
      let res = await this.rawFetch(method, path, body);
      let data: unknown = await res.json().catch(() => ({}));
      if (!res.ok && LangAPIClient.errorFrom(res.status, data).code === "TOKEN_EXPIRED") {
        const newToken = await forceRefreshAuthToken();
        if (newToken) {
          this.apiKey = newToken;
          res = await this.rawFetch(method, path, body);
          data = await res.json().catch(() => ({}));
        }
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { networkError: { code: "TIMEOUT", message: `Request timed out after ${this.timeoutMs}ms` } };
      }
      return { networkError: { code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Unknown network error" } };
    }
  }

  /** List glossary terms, optionally filtered to one language pair. */
  async listGlossary(sourceLang?: string, targetLang?: string): Promise<GlossaryListResult> {
    const path =
      sourceLang && targetLang
        ? `/api/v1/glossary/${encodeURIComponent(sourceLang)}/${encodeURIComponent(targetLang)}`
        : `/api/v1/glossary?limit=500`;
    const result = await this.authedJson("GET", path);
    if ("networkError" in result) return { success: false, error: result.networkError };
    if (!result.ok) return { success: false, error: LangAPIClient.errorFrom(result.status, result.data) };

    const obj = typeof result.data === "object" && result.data !== null ? (result.data as Record<string, unknown>) : {};
    if (Array.isArray(obj.data)) return { success: true, data: obj.data as GlossaryTermDto[] };
    return { success: false, error: { code: "INVALID_RESPONSE", message: "API returned an unexpected response format" } };
  }

  /** Create a glossary term. */
  async addGlossaryTerm(term: AddGlossaryTermRequest): Promise<GlossaryAddResult> {
    const result = await this.authedJson("POST", "/api/v1/glossary", term);
    if ("networkError" in result) return { success: false, error: result.networkError };
    if (!result.ok) return { success: false, error: LangAPIClient.errorFrom(result.status, result.data) };

    const obj = typeof result.data === "object" && result.data !== null ? (result.data as Record<string, unknown>) : {};
    if (typeof obj.data === "object" && obj.data !== null) return { success: true, data: obj.data as GlossaryTermDto };
    return { success: false, error: { code: "INVALID_RESPONSE", message: "API returned an unexpected response format" } };
  }

  /** Delete a glossary term by id. */
  async deleteGlossaryTerm(id: string): Promise<GlossaryDeleteResult> {
    const result = await this.authedJson("DELETE", `/api/v1/glossary/${encodeURIComponent(id)}`);
    if ("networkError" in result) return { success: false, error: result.networkError };
    if (!result.ok) return { success: false, error: LangAPIClient.errorFrom(result.status, result.data) };
    return { success: true };
  }
}
