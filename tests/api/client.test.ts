/**
 * Unit tests for LangAPIClient's request path — specifically the nested
 * auth-error envelope parsing and the refresh-and-single-retry behavior
 * (finding #8). The token-provider is mocked so we can drive the refresh
 * outcome deterministically; only the network boundary (fetch) is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TranslateFileRequest, TranslateFileResponse } from "../../src/api/types.js";

const mockForceRefresh = vi.fn<[], Promise<string | null>>();

vi.mock("../../src/auth/token-provider.js", () => ({
  getAuthToken: vi.fn(async () => "initial-token"),
  hasAnyCredentials: vi.fn(() => true),
  forceRefreshAuthToken: () => mockForceRefresh(),
}));

// Keep a stable base URL regardless of the host environment.
vi.mock("../../src/config/env.js", () => ({
  API_BASE_URL: "https://mock.langapi.io",
  getApiKey: () => null,
  isApiKeyConfigured: () => false,
  getMaskedApiKey: () => null,
}));

const REQUEST: TranslateFileRequest = {
  source_lang: "en",
  target_lang: "de",
  file_format: "json",
  source_file_content: JSON.stringify({ hello: "world" }),
  dry_run: false,
};

function authErrorResponse(code: string, message = "auth failed"): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), { status: 401 });
}

function successResponse(): Response {
  const body: TranslateFileResponse = {
    success: true,
    translated_file_content: JSON.stringify({ hello: "welt" }),
    delta: { newKeys: ["hello"], changedKeys: [], removedKeys: [], reusedFromCacheCount: 0 },
    cost: { creditsUsed: 10, balanceAfterSync: 990 },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function authHeaderOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe("LangAPIClient.translateFile — auth error handling (finding #8)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockForceRefresh.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function makeClient() {
    const { LangAPIClient } = await import("../../src/api/client.js");
    return new LangAPIClient("initial-token", "https://mock.langapi.io");
  }

  it("surfaces the nested error envelope code instead of a generic fallback", async () => {
    fetchMock.mockResolvedValueOnce(authErrorResponse("INVALID_TOKEN", "token is invalid"));

    const client = await makeClient();
    const result = await client.translateFile(REQUEST);

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error.code).toBe("INVALID_TOKEN");
      expect(result.error.message).toBe("token is invalid");
    }
    // INVALID_TOKEN is not retryable — no refresh attempted.
    expect(mockForceRefresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes and retries once with the new token on TOKEN_EXPIRED", async () => {
    fetchMock.mockResolvedValueOnce(authErrorResponse("TOKEN_EXPIRED")).mockResolvedValueOnce(successResponse());
    mockForceRefresh.mockResolvedValueOnce("refreshed-token");

    const client = await makeClient();
    const result = await client.translateFile(REQUEST);

    expect(result.success).toBe(true);
    expect(mockForceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call used the stale token, the retry used the refreshed one.
    expect(authHeaderOf(fetchMock.mock.calls[0][1])).toBe("Bearer initial-token");
    expect(authHeaderOf(fetchMock.mock.calls[1][1])).toBe("Bearer refreshed-token");
  });

  it("does not retry when there is no refresh token (static key / no session)", async () => {
    fetchMock.mockResolvedValueOnce(authErrorResponse("TOKEN_EXPIRED", "expired"));
    mockForceRefresh.mockResolvedValueOnce(null);

    const client = await makeClient();
    const result = await client.translateFile(REQUEST);

    expect(result.success).toBe(false);
    if (result.success === false) expect(result.error.code).toBe("TOKEN_EXPIRED");
    expect(mockForceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not loop when the retry also returns TOKEN_EXPIRED", async () => {
    fetchMock
      .mockResolvedValueOnce(authErrorResponse("TOKEN_EXPIRED"))
      .mockResolvedValueOnce(authErrorResponse("TOKEN_EXPIRED"));
    mockForceRefresh.mockResolvedValueOnce("refreshed-token");

    const client = await makeClient();
    const result = await client.translateFile(REQUEST);

    expect(result.success).toBe(false);
    if (result.success === false) expect(result.error.code).toBe("TOKEN_EXPIRED");
    // Refresh + retry attempted exactly once each — no infinite loop.
    expect(mockForceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
