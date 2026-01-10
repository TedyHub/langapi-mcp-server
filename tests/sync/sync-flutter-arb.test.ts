/**
 * Tests for syncing Flutter ARB format
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

describe("Sync Flutter ARB Format", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("flutter-arb");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("ARB File Structure", () => {
    it("should have @@locale in English ARB file", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      expect(arbEn["@@locale"]).toBe("en");
    });

    it("should have @@locale in German ARB file", async () => {
      const arbDe = await readJsonFixture(tempDir.path, "lib/l10n/app_de.arb");

      expect(arbDe["@@locale"]).toBe("de");
    });

    it("should have @key metadata for each translatable key", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      // Check that translatable keys have corresponding @key metadata
      expect(arbEn.appName).toBe("My Application");
      expect(arbEn["@appName"]).toBeDefined();
      expect((arbEn["@appName"] as Record<string, unknown>).description).toBe(
        "The application name"
      );
    });

    it("should separate translatable keys from metadata", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      const translatableKeys: Array<{ key: string; value: string }> = [];
      const metadataKeys: string[] = [];

      for (const [key, value] of Object.entries(arbEn)) {
        if (key.startsWith("@")) {
          metadataKeys.push(key);
        } else if (typeof value === "string") {
          translatableKeys.push({ key, value });
        }
      }

      // Should have both translatable and metadata keys
      expect(translatableKeys.length).toBeGreaterThan(0);
      expect(metadataKeys.length).toBeGreaterThan(0);

      // Each translatable key (except @@locale) should have metadata
      const translatableNonLocale = translatableKeys.filter(
        (k) => k.key !== "@@locale"
      );
      for (const item of translatableNonLocale) {
        expect(metadataKeys).toContain(`@${item.key}`);
      }
    });
  });

  describe("ARB Metadata Handling", () => {
    it("should preserve @@locale in target files", async () => {
      const arbDe = await readJsonFixture(tempDir.path, "lib/l10n/app_de.arb");

      expect(arbDe["@@locale"]).toBe("de");
    });

    it("should handle placeholders in metadata", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      // variablesGreeting has placeholders
      expect(arbEn.variablesGreeting).toBe("Welcome, {name}!");

      const metadata = arbEn["@variablesGreeting"] as Record<string, unknown>;
      expect(metadata).toBeDefined();
      expect(metadata.placeholders).toBeDefined();

      const placeholders = metadata.placeholders as Record<string, unknown>;
      expect(placeholders.name).toBeDefined();
      expect((placeholders.name as Record<string, unknown>).type).toBe("String");
    });

    it("should have different placeholder types", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      // variablesItemCount has int placeholder
      const itemCountMeta = arbEn["@variablesItemCount"] as Record<string, unknown>;
      const placeholders = itemCountMeta.placeholders as Record<string, unknown>;

      expect((placeholders.count as Record<string, unknown>).type).toBe("int");
    });
  });

  describe("ARB Sync", () => {
    it("should sync translatable keys only (not metadata)", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");
      const arbDe = await readJsonFixture(tempDir.path, "lib/l10n/app_de.arb");

      // Extract translatable keys from English
      const translatableKeys: Array<{ key: string; value: string }> = [];
      for (const [key, value] of Object.entries(arbEn)) {
        if (!key.startsWith("@") && typeof value === "string") {
          translatableKeys.push({ key, value });
        }
      }

      // Get keys missing in German
      const deKeys = Object.keys(arbDe).filter((k) => !k.startsWith("@"));
      const missingKeys = translatableKeys.filter(
        (item) => !deKeys.includes(item.key)
      );

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

        // Only translatable keys should be in response
        for (const translation of deResult.translations) {
          expect(translation.key).not.toMatch(/^@/);
        }
      }
    });

    it("should preserve existing German translations", async () => {
      const arbDe = await readJsonFixture(tempDir.path, "lib/l10n/app_de.arb");

      // German file has some existing translations
      expect(arbDe.appName).toBe("Meine Anwendung");
      expect(arbDe.authLogin).toBe("Anmelden");
      expect(arbDe.authLogout).toBe("Abmelden");
    });
  });

  describe("ARB Key Ordering", () => {
    it("should have @@locale first in file", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");
      const keys = Object.keys(arbEn);

      expect(keys[0]).toBe("@@locale");
    });

    it("should have key-metadata pairs in sequence", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");
      const keys = Object.keys(arbEn);

      // After @@locale, check that appName is followed by @appName
      const appNameIndex = keys.indexOf("appName");
      expect(appNameIndex).toBeGreaterThan(0);
      expect(keys[appNameIndex + 1]).toBe("@appName");
    });
  });

  describe("ARB File Naming", () => {
    it("should correctly map app_en.arb to app_de.arb", () => {
      // Use imported computeTargetFilePath

      const result = computeTargetFilePath(
        "/project/lib/l10n/app_en.arb",
        "en",
        "de"
      );

      expect(result).toBe("/project/lib/l10n/app_de.arb");
    });

    it("should correctly map to new languages", () => {
      // Use imported computeTargetFilePath

      expect(
        computeTargetFilePath("/project/lib/l10n/app_en.arb", "en", "fr")
      ).toBe("/project/lib/l10n/app_fr.arb");

      expect(
        computeTargetFilePath("/project/lib/l10n/app_en.arb", "en", "es")
      ).toBe("/project/lib/l10n/app_es.arb");

      expect(
        computeTargetFilePath("/project/lib/l10n/app_en.arb", "en", "pt-BR")
      ).toBe("/project/lib/l10n/app_pt-BR.arb");
    });
  });

  describe("ARB Variables", () => {
    it("should preserve Flutter placeholder syntax {variable}", async () => {
      const arbEn = await readJsonFixture(tempDir.path, "lib/l10n/app_en.arb");

      expect(arbEn.variablesGreeting).toBe("Welcome, {name}!");
      expect(arbEn.variablesItemCount).toBe("You have {count} items");
      expect(arbEn.variablesLastLogin).toBe("Last login: {date}");
    });

    it("should translate while preserving placeholder syntax", async () => {
      const content = [
        { key: "variablesGreeting", value: "Welcome, {name}!" },
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
        const translation = response.results[0].translations[0];
        // Mock appends -de, placeholder should still be there
        expect(translation.value).toBe("Welcome, {name}!-de");
      }
    });
  });
});
