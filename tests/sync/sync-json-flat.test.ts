/**
 * Tests for syncing JSON flat format (react-intl style)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import { readJsonFixture } from "../helpers/fixture-loader.js";
import { mockTranslate } from "../mocks/api-client.mock.js";

// Mock the fetch API for LangAPIClient
const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

// Mock the env module
vi.mock("../../src/config/env.js", () => ({
  API_BASE_URL: "https://mock.langapi.io",
  getApiKey: () => "mock-api-key",
  isApiKeyConfigured: () => true,
  getMaskedApiKey: () => "mock-***",
}));

/**
 * Create a mock API response for execute mode
 */
function createMockExecuteResponse(
  content: Array<{ key: string; value: string }>,
  targetLangs: string[]
) {
  return {
    success: true,
    results: targetLangs.map((lang) => ({
      language: lang,
      translatedCount: content.length,
      translations: content.map((c) => ({
        key: c.key,
        value: mockTranslate(c.value, lang),
      })),
    })),
    cost: {
      creditsUsed: content.length * 10,
      balanceAfterSync: 10000 - content.length * 10,
    },
  };
}

describe("Sync JSON Flat Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("json-flat");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("Flat Key Handling", () => {
    it("should preserve flat keys with dots (e.g., 'app.name')", async () => {
      const source = await readJsonFixture(tempDir.path, "src/lang/en.json");

      // Verify keys are already flat (contain dots but not nested)
      const keys = Object.keys(source);
      expect(keys.some((k) => k.includes("."))).toBe(true);
      expect(keys.includes("app.name")).toBe(true);
      expect(keys.includes("auth.login")).toBe(true);

      // Verify values are strings, not objects
      expect(typeof source["app.name"]).toBe("string");
      expect(typeof source["auth.login"]).toBe("string");
    });

    it("should correctly sync all flat keys", async () => {
      const source = await readJsonFixture(tempDir.path, "src/lang/en.json");
      const target = await readJsonFixture(tempDir.path, "src/lang/de.json");

      // Get missing keys
      const sourceKeys = Object.keys(source);
      const targetKeys = Object.keys(target);
      const missingKeys = sourceKeys.filter((k) => !targetKeys.includes(k));

      expect(missingKeys.length).toBeGreaterThan(0);

      // Create content for API call
      const content = missingKeys.map((key) => ({
        key,
        value: source[key] as string,
      }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(content, ["de"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        const deResult = response.results[0];
        expect(deResult.translatedCount).toBe(missingKeys.length);

        // Verify translations have correct keys
        for (const translation of deResult.translations) {
          expect(missingKeys).toContain(translation.key);
          expect(translation.value).toContain("-de");
        }
      }
    });

    it("should handle flat keys with special characters", async () => {
      const content = [
        { key: "app.name", value: "My App" },
        { key: "auth.forgot_password", value: "Forgot password?" },
        { key: "errors.not_found", value: "Page not found" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(content, ["fr"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["fr"],
        content,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        const frResult = response.results[0];

        // Keys should be preserved exactly as-is
        const translatedKeys = frResult.translations.map((t) => t.key);
        expect(translatedKeys).toContain("app.name");
        expect(translatedKeys).toContain("auth.forgot_password");
        expect(translatedKeys).toContain("errors.not_found");
      }
    });
  });

  describe("Existing Translations", () => {
    it("should identify which keys already exist in target", async () => {
      const source = await readJsonFixture(tempDir.path, "src/lang/en.json");
      const target = await readJsonFixture(tempDir.path, "src/lang/de.json");

      // de.json has some translations
      expect(Object.keys(target).length).toBeGreaterThan(0);
      expect(target["app.name"]).toBe("Meine Anwendung");
      expect(target["auth.login"]).toBe("Anmelden");

      // en.json has more keys
      expect(Object.keys(source).length).toBeGreaterThan(Object.keys(target).length);
    });

    it("should sync only missing keys to target", async () => {
      const source = await readJsonFixture(tempDir.path, "src/lang/en.json");
      const target = await readJsonFixture(tempDir.path, "src/lang/de.json");

      const sourceKeys = Object.keys(source);
      const targetKeys = Object.keys(target);
      const missingKeys = sourceKeys.filter((k) => !targetKeys.includes(k));

      const content = missingKeys.map((key) => ({
        key,
        value: source[key] as string,
      }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(content, ["de"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        // Only missing keys should be translated
        expect(response.results[0].translatedCount).toBe(missingKeys.length);
      }
    });
  });

  describe("Multiple Target Languages", () => {
    it("should sync to multiple languages at once", async () => {
      const source = await readJsonFixture(tempDir.path, "src/lang/en.json");
      const sourceKeys = Object.keys(source);

      const content = sourceKeys.map((key) => ({
        key,
        value: source[key] as string,
      }));

      const targetLangs = ["de", "fr", "es"];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(content, targetLangs),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: targetLangs,
        content,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        expect(response.results.length).toBe(3);

        // Each language should have all keys translated
        for (const result of response.results) {
          expect(result.translatedCount).toBe(sourceKeys.length);
          expect(targetLangs).toContain(result.language);

          // Verify translation has correct suffix
          for (const translation of result.translations) {
            expect(translation.value).toContain(`-${result.language}`);
          }
        }
      }
    });
  });
});
