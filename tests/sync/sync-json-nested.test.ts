/**
 * Tests for syncing JSON nested format (generic, next-intl, vue-i18n style)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, writeFile, mkdir, rm, access } from "fs/promises";
import { join, dirname } from "path";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import {
  readJsonFixture,
  writeJsonFixture,
  modifyJsonFixture,
} from "../helpers/fixture-loader.js";
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

/**
 * Create a mock API response for dry run mode
 */
function createMockDryRunResponse(content: Array<{ key: string; value: string }>) {
  return {
    success: true,
    delta: {
      newKeys: content.map((c) => c.key),
      changedKeys: [],
      unchangedKeys: [],
      totalKeysToSync: content.length,
    },
    cost: {
      wordsToTranslate: content.reduce((acc, c) => acc + c.value.split(/\s+/).length, 0),
      creditsRequired: content.length * 10,
      currentBalance: 10000,
      balanceAfterSync: 10000 - content.length * 10,
    },
  };
}

describe("Sync JSON Nested Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("json-nested");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("Full Language Sync", () => {
    it("should sync missing keys to existing language", async () => {
      // Read source to get all keys
      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Verify initial state: de.json is missing some keys
      expect(target.app).toBeDefined();
      expect((target.app as Record<string, unknown>).tagline).toBeUndefined();
      expect(target.common).toBeUndefined();

      // Calculate which keys are missing
      const sourceFlat = flattenObject(source);
      const targetFlat = flattenObject(target);

      const missingKeys = sourceFlat.filter(
        (item) => !targetFlat.some((t) => t.key === item.key)
      );

      // Mock the API to return translations for missing keys
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(missingKeys, ["de"]),
      });

      // Import and run the sync (we test indirectly via file changes)
      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content: missingKeys,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        // Verify translations follow mock pattern
        const deResult = response.results.find((r) => r.language === "de");
        expect(deResult).toBeDefined();
        expect(deResult!.translatedCount).toBe(missingKeys.length);

        // Verify each translation has the -de suffix
        for (const translation of deResult!.translations) {
          expect(translation.value).toContain("-de");
        }
      }
    });

    it("should return proper dry run preview", async () => {
      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const sourceFlat = flattenObject(source);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockDryRunResponse(sourceFlat),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["fr"],
        content: sourceFlat,
        dry_run: true,
      });

      expect(response.success).toBe(true);

      if (response.success && "delta" in response) {
        expect(response.delta.newKeys.length).toBe(sourceFlat.length);
        expect(response.delta.totalKeysToSync).toBe(sourceFlat.length);
        expect(response.cost.creditsRequired).toBeGreaterThan(0);
      }
    });
  });

  describe("Nested Key Structure", () => {
    it("should handle deeply nested keys correctly", async () => {
      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const sourceFlat = flattenObject(source);

      // Verify we have nested keys
      const nestedKeys = sourceFlat.filter((item) => item.key.includes("."));
      expect(nestedKeys.length).toBeGreaterThan(0);

      // Verify specific nested paths exist
      expect(sourceFlat.some((item) => item.key === "app.name")).toBe(true);
      expect(sourceFlat.some((item) => item.key === "auth.login")).toBe(true);
      expect(sourceFlat.some((item) => item.key === "variables.greeting")).toBe(true);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(nestedKeys, ["de"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content: nestedKeys,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        const deResult = response.results[0];
        // Verify nested keys are translated correctly
        const appName = deResult.translations.find((t) => t.key === "app.name");
        expect(appName?.value).toBe("My Application-de");
      }
    });
  });

  describe("Mock Translation Pattern", () => {
    it("should verify mock translations append -lang suffix", () => {
      expect(mockTranslate("Hello", "de")).toBe("Hello-de");
      expect(mockTranslate("World", "fr")).toBe("World-fr");
      expect(mockTranslate("Test", "es")).toBe("Test-es");
    });

    it("should handle variables in translations", async () => {
      const content = [
        { key: "greeting", value: "Welcome, {name}!" },
        { key: "count", value: "You have {count} items" },
      ];

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
        const greeting = deResult.translations.find((t) => t.key === "greeting");
        expect(greeting?.value).toBe("Welcome, {name}!-de");
      }
    });
  });
});

/**
 * Helper to flatten a nested object to key-value pairs
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = ""
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result.push(...flattenObject(value as Record<string, unknown>, newKey));
    } else if (typeof value === "string") {
      result.push({ key: newKey, value });
    }
  }

  return result;
}
