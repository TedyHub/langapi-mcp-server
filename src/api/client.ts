/**
 * LangAPI client for making API requests
 */

import { API_BASE_URL, getApiKey } from "../config/env.js";
import type {
  SyncRequest,
  SyncResponse,
  SyncDryRunResponse,
  SyncExecuteResponse,
} from "./types.js";

/** Default request timeout in milliseconds (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Type guard for SyncDryRunResponse
 */
function isSyncDryRunResponse(data: unknown): data is SyncDryRunResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.success === true &&
    typeof obj.delta === "object" &&
    obj.delta !== null &&
    typeof obj.cost === "object" &&
    obj.cost !== null &&
    "wordsToTranslate" in (obj.cost as Record<string, unknown>)
  );
}

/**
 * Type guard for SyncExecuteResponse
 */
function isSyncExecuteResponse(data: unknown): data is SyncExecuteResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.success === true &&
    Array.isArray(obj.results) &&
    typeof obj.cost === "object" &&
    obj.cost !== null &&
    "creditsUsed" in (obj.cost as Record<string, unknown>)
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
   * Create a client instance using the configured API key
   * @throws Error if no API key is configured
   */
  static create(): LangAPIClient {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error(
        "No API key configured. Set the LANGAPI_API_KEY environment variable."
      );
    }
    return new LangAPIClient(apiKey);
  }

  /**
   * Check if client can be created (API key is configured)
   */
  static canCreate(): boolean {
    return !!getApiKey();
  }

  /**
   * Sync translations with the LangAPI service
   */
  async sync(request: SyncRequest): Promise<SyncResponse> {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/sync`, {
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
        // Parse error response safely
        const errorObj =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>)
            : {};
        const errorData =
          typeof errorObj.error === "object" && errorObj.error !== null
            ? (errorObj.error as Record<string, unknown>)
            : {};

        return {
          success: false,
          error: {
            code: typeof errorData.code === "string" ? errorData.code : "API_ERROR",
            message:
              typeof errorData.message === "string"
                ? errorData.message
                : `HTTP ${response.status}`,
            currentBalance:
              typeof errorData.currentBalance === "number"
                ? errorData.currentBalance
                : undefined,
            requiredCredits:
              typeof errorData.requiredCredits === "number"
                ? errorData.requiredCredits
                : undefined,
            topUpUrl:
              typeof errorData.topUpUrl === "string"
                ? errorData.topUpUrl
                : undefined,
          },
        };
      }

      // Validate successful response using type guards
      if (isSyncDryRunResponse(data)) {
        return data;
      }
      if (isSyncExecuteResponse(data)) {
        return data;
      }

      // Unknown response format
      return {
        success: false,
        error: {
          code: "INVALID_RESPONSE",
          message: "API returned an unexpected response format",
        },
      };
    } catch (error) {
      // Handle timeout and network errors
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: {
            code: "TIMEOUT",
            message: `Request timed out after ${this.timeoutMs}ms`,
          },
        };
      }
      return {
        success: false,
        error: {
          code: "NETWORK_ERROR",
          message: error instanceof Error ? error.message : "Unknown network error",
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
