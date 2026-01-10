/**
 * Tests for syncing iOS .xcstrings format (Modern Xcode String Catalog)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import { readJsonFixture } from "../helpers/fixture-loader.js";
import { mockTranslate } from "../mocks/api-client.mock.js";
import { computeTargetFilePath } from "../../src/tools/sync-translations.js";

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

interface XCStringsFile {
  sourceLanguage: string;
  strings: Record<
    string,
    {
      localizations?: Record<
        string,
        {
          stringUnit?: {
            state: string;
            value: string;
          };
        }
      >;
    }
  >;
  version: string;
}

describe("Sync iOS .xcstrings Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("ios-xcstrings");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("XCStrings Structure", () => {
    it("should have correct sourceLanguage", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      expect(xcstrings.sourceLanguage).toBe("en");
    });

    it("should have version field", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      expect(xcstrings.version).toBe("1.0");
    });

    it("should contain all strings with localizations", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      expect(xcstrings.strings).toBeDefined();
      expect(Object.keys(xcstrings.strings).length).toBeGreaterThan(0);

      // Check a specific string entry
      const appName = xcstrings.strings["app.name"];
      expect(appName).toBeDefined();
      expect(appName.localizations).toBeDefined();
    });
  });

  describe("Single File Multi-Language", () => {
    it("should contain English translations", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const appName = xcstrings.strings["app.name"];
      expect(appName.localizations?.en).toBeDefined();
      expect(appName.localizations?.en?.stringUnit?.value).toBe("My Application");
      expect(appName.localizations?.en?.stringUnit?.state).toBe("translated");
    });

    it("should contain German translations for some keys", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      // app.name has German translation
      const appName = xcstrings.strings["app.name"];
      expect(appName.localizations?.de).toBeDefined();
      expect(appName.localizations?.de?.stringUnit?.value).toBe("Meine Anwendung");

      // auth.login has German translation
      const authLogin = xcstrings.strings["auth.login"];
      expect(authLogin.localizations?.de?.stringUnit?.value).toBe("Anmelden");
    });

    it("should identify keys missing German translations", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const missingKeys: string[] = [];

      for (const [key, entry] of Object.entries(xcstrings.strings)) {
        if (!entry.localizations?.de) {
          missingKeys.push(key);
        }
      }

      expect(missingKeys.length).toBeGreaterThan(0);
      expect(missingKeys).toContain("auth.forgot_password");
      expect(missingKeys).toContain("common.save");
    });
  });

  describe("XCStrings Sync", () => {
    it("should sync missing keys to existing language", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      // Get keys missing German translations
      const missingContent: Array<{ key: string; value: string }> = [];

      for (const [key, entry] of Object.entries(xcstrings.strings)) {
        if (!entry.localizations?.de && entry.localizations?.en) {
          missingContent.push({
            key,
            value: entry.localizations.en.stringUnit?.value || "",
          });
        }
      }

      expect(missingContent.length).toBeGreaterThan(0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(missingContent, ["de"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content: missingContent,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        const deResult = response.results[0];
        expect(deResult.translatedCount).toBe(missingContent.length);
      }
    });

    it("should sync to completely new language", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      // Get all English keys for French (new language)
      const content: Array<{ key: string; value: string }> = [];

      for (const [key, entry] of Object.entries(xcstrings.strings)) {
        if (entry.localizations?.en?.stringUnit?.value) {
          content.push({
            key,
            value: entry.localizations.en.stringUnit.value,
          });
        }
      }

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
        expect(frResult.translatedCount).toBe(content.length);

        // All translations should have French suffix
        for (const translation of frResult.translations) {
          expect(translation.value).toContain("-fr");
        }
      }
    });
  });

  describe("Translation State", () => {
    it("should have 'translated' state for existing translations", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      // Check that translated entries have correct state
      const appName = xcstrings.strings["app.name"];
      expect(appName.localizations?.en?.stringUnit?.state).toBe("translated");
      expect(appName.localizations?.de?.stringUnit?.state).toBe("translated");
    });
  });

  describe("XCStrings File Path", () => {
    it("should return same path for xcstrings (single file contains all languages)", () => {
      // Use imported computeTargetFilePath

      const result = computeTargetFilePath(
        "/project/Localizable.xcstrings",
        "en",
        "de"
      );

      // XCStrings files contain all languages, so path stays the same
      expect(result).toBe("/project/Localizable.xcstrings");
    });

    it("should handle nested xcstrings paths", () => {
      // Use imported computeTargetFilePath

      const result = computeTargetFilePath(
        "/MyApp/Resources/Localizable.xcstrings",
        "en",
        "fr"
      );

      expect(result).toBe("/MyApp/Resources/Localizable.xcstrings");
    });
  });

  describe("Format Specifiers", () => {
    it("should have %@ string specifiers", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const greeting = xcstrings.strings["variables.greeting"];
      expect(greeting.localizations?.en?.stringUnit?.value).toBe("Welcome, %@!");
    });

    it("should have %lld integer specifiers", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const itemCount = xcstrings.strings["variables.itemCount"];
      expect(itemCount.localizations?.en?.stringUnit?.value).toBe(
        "You have %lld items"
      );
    });
  });

  describe("Key Deletion", () => {
    it("should identify which keys to remove when source changes", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const sourceKeys = Object.keys(xcstrings.strings);
      const targetLang = "de";

      // Simulate removing a key from source
      const keysToKeep = sourceKeys.filter((k) => k !== "app.tagline");

      // Keys that would be removed from target
      const keysThatWouldBeRemoved = sourceKeys.filter(
        (k) => !keysToKeep.includes(k)
      );

      expect(keysThatWouldBeRemoved).toContain("app.tagline");

      // Verify that app.tagline exists in German
      expect(xcstrings.strings["app.tagline"].localizations?.de).toBeDefined();
    });
  });

  describe("Multiple Languages Sync", () => {
    it("should sync to multiple languages at once", async () => {
      const xcstrings = (await readJsonFixture(
        tempDir.path,
        "Localizable.xcstrings"
      )) as unknown as XCStringsFile;

      const content: Array<{ key: string; value: string }> = [];
      for (const [key, entry] of Object.entries(xcstrings.strings)) {
        if (entry.localizations?.en?.stringUnit?.value) {
          content.push({
            key,
            value: entry.localizations.en.stringUnit.value,
          });
        }
      }

      const targetLangs = ["fr", "es", "it", "pt"];

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
        expect(response.results.length).toBe(4);

        for (const result of response.results) {
          expect(targetLangs).toContain(result.language);
          expect(result.translatedCount).toBe(content.length);
        }
      }
    });
  });
});
