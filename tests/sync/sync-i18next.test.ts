/**
 * Tests for syncing i18next namespaced format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { access } from "fs/promises";
import { join } from "path";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import { readJsonFixture, fileExists } from "../helpers/fixture-loader.js";
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

describe("Sync i18next Namespaced Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("i18next");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("Multiple Namespace Files", () => {
    it("should have separate namespace files for common and home", async () => {
      // Verify fixture structure
      const commonExists = await fileExists(
        tempDir.path,
        "public/locales/en/common.json"
      );
      const homeExists = await fileExists(
        tempDir.path,
        "public/locales/en/home.json"
      );

      expect(commonExists).toBe(true);
      expect(homeExists).toBe(true);
    });

    it("should sync common.json namespace", async () => {
      const commonEn = await readJsonFixture(
        tempDir.path,
        "public/locales/en/common.json"
      );
      const keys = Object.keys(commonEn);

      expect(keys.length).toBeGreaterThan(0);
      expect(commonEn.app_name).toBe("My Application");
      expect(commonEn.save).toBe("Save");

      const content = keys.map((key) => ({
        key,
        value: commonEn[key] as string,
      }));

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
        const appName = frResult.translations.find((t) => t.key === "app_name");
        expect(appName?.value).toBe("My Application-fr");
      }
    });

    it("should sync home.json namespace", async () => {
      const homeEn = await readJsonFixture(
        tempDir.path,
        "public/locales/en/home.json"
      );
      const keys = Object.keys(homeEn);

      expect(keys.length).toBeGreaterThan(0);
      expect(homeEn.title).toBe("Welcome Home");

      // Flatten nested structure if present
      const content: Array<{ key: string; value: string }> = [];
      flattenForI18next(homeEn, "", content);

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
        const title = deResult.translations.find((t) => t.key === "title");
        expect(title?.value).toBe("Welcome Home-de");
      }
    });

    it("should handle partial German translations", async () => {
      // de/common.json exists but is partial
      const commonDe = await readJsonFixture(
        tempDir.path,
        "public/locales/de/common.json"
      );

      expect(commonDe.app_name).toBe("Meine Anwendung");
      expect(commonDe.save).toBe("Speichern");

      // Should be missing many keys
      expect(commonDe.cancel).toBeUndefined();
      expect(commonDe.greeting).toBeUndefined();
    });

    it("should identify missing de/home.json namespace file", async () => {
      const homeDeExists = await fileExists(
        tempDir.path,
        "public/locales/de/home.json"
      );

      // de/home.json should not exist in fixture
      expect(homeDeExists).toBe(false);
    });
  });

  describe("Namespace Isolation", () => {
    it("should not mix keys between namespaces", async () => {
      const commonEn = await readJsonFixture(
        tempDir.path,
        "public/locales/en/common.json"
      );
      const homeEn = await readJsonFixture(
        tempDir.path,
        "public/locales/en/home.json"
      );

      const commonKeys = Object.keys(commonEn);
      const homeKeys = getAllKeys(homeEn);

      // Keys should be separate
      // common has: app_name, save, cancel, etc.
      // home has: title, subtitle, features, etc.
      expect(commonKeys.includes("app_name")).toBe(true);
      expect(homeKeys.includes("title")).toBe(true);

      // These should not exist in the other namespace
      expect(homeKeys.includes("app_name")).toBe(false);
      expect(commonKeys.includes("title")).toBe(false);
    });
  });

  describe("i18next Variable Syntax", () => {
    it("should preserve double curly brace variables", async () => {
      const commonEn = await readJsonFixture(
        tempDir.path,
        "public/locales/en/common.json"
      );

      // i18next uses {{variable}} syntax
      expect(commonEn.greeting).toBe("Welcome, {{name}}!");
      expect(commonEn.item_count).toBe("You have {{count}} items");
    });

    it("should translate while preserving variable syntax", async () => {
      const content = [
        { key: "greeting", value: "Welcome, {{name}}!" },
        { key: "item_count", value: "You have {{count}} items" },
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

        // Mock preserves the original value + suffix
        const greeting = deResult.translations.find((t) => t.key === "greeting");
        expect(greeting?.value).toBe("Welcome, {{name}}!-de");
      }
    });
  });
});

/**
 * Flatten i18next object (which can have nested keys)
 */
function flattenForI18next(
  obj: Record<string, unknown>,
  prefix: string,
  result: Array<{ key: string; value: string }>
): void {
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenForI18next(value as Record<string, unknown>, newKey, result);
    } else if (typeof value === "string") {
      result.push({ key: newKey, value });
    }
  }
}

/**
 * Get all keys from nested object
 */
function getAllKeys(
  obj: Record<string, unknown>,
  prefix = ""
): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    keys.push(newKey);

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...getAllKeys(value as Record<string, unknown>, newKey));
    }
  }

  return keys;
}
