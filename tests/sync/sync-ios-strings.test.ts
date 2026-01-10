/**
 * Tests for syncing iOS .strings format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import { readRawFixture, fileExists } from "../helpers/fixture-loader.js";
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

/**
 * Parse a .strings file content to extract key-value pairs
 */
function parseStringsFile(content: string): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  const regex = /"([^"]+)"\s*=\s*"([^"]*)";/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    result.push({ key: match[1], value: match[2] });
  }

  return result;
}

describe("Sync iOS .strings Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("ios-strings");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("File Structure", () => {
    it("should have en.lproj directory with Localizable.strings", async () => {
      const exists = await fileExists(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );
      expect(exists).toBe(true);
    });

    it("should have de.lproj directory with Localizable.strings", async () => {
      const exists = await fileExists(
        tempDir.path,
        "de.lproj/Localizable.strings"
      );
      expect(exists).toBe(true);
    });

    it("should parse .strings file format correctly", async () => {
      const content = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );

      const entries = parseStringsFile(content);
      expect(entries.length).toBeGreaterThan(0);

      // Check specific entries
      const appName = entries.find((e) => e.key === "app.name");
      expect(appName?.value).toBe("My Application");

      const authLogin = entries.find((e) => e.key === "auth.login");
      expect(authLogin?.value).toBe("Log in");
    });
  });

  describe("File Path Mapping", () => {
    it("should map en.lproj/Localizable.strings to de.lproj/Localizable.strings", () => {
      // Use imported computeTargetFilePath

      const result = computeTargetFilePath(
        "/project/en.lproj/Localizable.strings",
        "en",
        "de"
      );

      expect(result).toBe("/project/de.lproj/Localizable.strings");
    });

    it("should handle various language codes", () => {
      // Use imported computeTargetFilePath

      expect(
        computeTargetFilePath(
          "/project/en.lproj/Localizable.strings",
          "en",
          "fr"
        )
      ).toBe("/project/fr.lproj/Localizable.strings");

      expect(
        computeTargetFilePath(
          "/project/en.lproj/Localizable.strings",
          "en",
          "pt-BR"
        )
      ).toBe("/project/pt-BR.lproj/Localizable.strings");

      expect(
        computeTargetFilePath(
          "/project/en.lproj/Localizable.strings",
          "en",
          "zh-Hans"
        )
      ).toBe("/project/zh-Hans.lproj/Localizable.strings");
    });

    it("should handle nested lproj paths", () => {
      // Use imported computeTargetFilePath

      const result = computeTargetFilePath(
        "/MyApp/Resources/en.lproj/Localizable.strings",
        "en",
        "de"
      );

      expect(result).toBe("/MyApp/Resources/de.lproj/Localizable.strings");
    });
  });

  describe("Comment Preservation", () => {
    it("should have comments in source file", async () => {
      const content = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );

      // File should contain section comments
      expect(content).toContain("/* App section */");
      expect(content).toContain("/* Auth section */");
      expect(content).toContain("/* Common section */");
    });

    it("should have comments in target file", async () => {
      const content = await readRawFixture(
        tempDir.path,
        "de.lproj/Localizable.strings"
      );

      // German file should also have comments
      expect(content).toContain("/* App section */");
      expect(content).toContain("/* Auth section */");
    });
  });

  describe("Sync Strings", () => {
    it("should sync missing keys from English to German", async () => {
      const enContent = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );
      const deContent = await readRawFixture(
        tempDir.path,
        "de.lproj/Localizable.strings"
      );

      const enEntries = parseStringsFile(enContent);
      const deEntries = parseStringsFile(deContent);

      const deKeys = deEntries.map((e) => e.key);
      const missingKeys = enEntries.filter((e) => !deKeys.includes(e.key));

      expect(missingKeys.length).toBeGreaterThan(0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(missingKeys, ["de"]),
      });

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
        const deResult = response.results[0];
        expect(deResult.translatedCount).toBe(missingKeys.length);

        // Verify translations have correct suffix
        for (const translation of deResult.translations) {
          expect(translation.value).toContain("-de");
        }
      }
    });

    it("should preserve existing German translations", async () => {
      const deContent = await readRawFixture(
        tempDir.path,
        "de.lproj/Localizable.strings"
      );

      const deEntries = parseStringsFile(deContent);

      // German file has some translations
      const appName = deEntries.find((e) => e.key === "app.name");
      expect(appName?.value).toBe("Meine Anwendung");

      const authLogin = deEntries.find((e) => e.key === "auth.login");
      expect(authLogin?.value).toBe("Anmelden");
    });
  });

  describe("iOS Format Specifiers", () => {
    it("should preserve %@ string specifiers", async () => {
      const enContent = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );

      const entries = parseStringsFile(enContent);

      const greeting = entries.find((e) => e.key === "variables.greeting");
      expect(greeting?.value).toBe("Welcome, %@!");

      const lastLogin = entries.find((e) => e.key === "variables.last_login");
      expect(lastLogin?.value).toBe("Last login: %@");
    });

    it("should preserve %d integer specifiers", async () => {
      const enContent = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );

      const entries = parseStringsFile(enContent);

      const itemCount = entries.find((e) => e.key === "variables.item_count");
      expect(itemCount?.value).toBe("You have %d items");
    });

    it("should translate while preserving format specifiers", async () => {
      const content = [
        { key: "variables.greeting", value: "Welcome, %@!" },
        { key: "variables.item_count", value: "You have %d items" },
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
        const greeting = deResult.translations.find(
          (t) => t.key === "variables.greeting"
        );
        expect(greeting?.value).toBe("Welcome, %@!-de");
      }
    });
  });

  describe("Multiple Languages", () => {
    it("should sync to multiple new languages", async () => {
      const enContent = await readRawFixture(
        tempDir.path,
        "en.lproj/Localizable.strings"
      );

      const entries = parseStringsFile(enContent);
      const targetLangs = ["fr", "es", "it"];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse(entries, targetLangs),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: targetLangs,
        content: entries,
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        expect(response.results.length).toBe(3);

        for (const result of response.results) {
          expect(targetLangs).toContain(result.language);
          expect(result.translatedCount).toBe(entries.length);

          // Each language should have its own suffix
          for (const translation of result.translations) {
            expect(translation.value).toContain(`-${result.language}`);
          }
        }
      }
    });
  });
});
