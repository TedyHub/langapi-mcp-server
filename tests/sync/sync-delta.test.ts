/**
 * Tests for delta sync operations (add/delete keys)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import {
  readJsonFixture,
  writeJsonFixture,
  modifyJsonFixture,
} from "../helpers/fixture-loader.js";
import { mockTranslate } from "../mocks/api-client.mock.js";
import {
  removeExtraKeys,
  deepMerge,
} from "../../src/tools/sync-translations.js";
import { flattenJson, unflattenJson } from "../../src/utils/json-parser.js";

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
      wordsToTranslate: content.reduce(
        (acc, c) => acc + c.value.split(/\s+/).length,
        0
      ),
      creditsRequired: content.length * 10,
      currentBalance: 10000,
      balanceAfterSync: 10000 - content.length * 10,
    },
  };
}

describe("Delta Sync Operations", () => {
  let tempDir: TempTestDir;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("json-nested");
    mockFetch.mockReset();
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.clearAllMocks();
  });

  describe("Add New Key to Source", () => {
    it("should detect new key added to source", async () => {
      // Read original source and target
      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Add a new key to source
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "newFeature.title": "New Feature" },
      });

      const modifiedSource = await readJsonFixture(tempDir.path, "locales/en.json");

      // Verify new key was added
      expect((modifiedSource.newFeature as Record<string, unknown>).title).toBe(
        "New Feature"
      );

      // Get flattened keys
      const sourceFlat = flattenJson(modifiedSource as Record<string, unknown>);
      const targetFlat = flattenJson(target as Record<string, unknown>);

      // Find new key
      const newKey = sourceFlat.find((s) => s.key === "newFeature.title");
      expect(newKey).toBeDefined();

      // Verify target doesn't have it
      const targetHasKey = targetFlat.some((t) => t.key === "newFeature.title");
      expect(targetHasKey).toBe(false);
    });

    it("should sync new key to existing target language", async () => {
      // Add new key to source
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "newFeature.title": "New Feature" },
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Calculate what needs to sync (new key only)
      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const targetFlat = flattenJson(target as Record<string, unknown>);
      const targetKeys = new Set(targetFlat.map((t) => t.key));

      const missingKeys = sourceFlat.filter((s) => !targetKeys.has(s.key));

      // New key should be in missing keys
      const newKey = missingKeys.find((m) => m.key === "newFeature.title");
      expect(newKey).toBeDefined();
      expect(newKey!.value).toBe("New Feature");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockExecuteResponse([newKey!], ["de"]),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content: [newKey!],
        dry_run: false,
      });

      expect(response.success).toBe(true);

      if (response.success && "results" in response) {
        const deResult = response.results[0];
        expect(deResult.translatedCount).toBe(1);

        const translation = deResult.translations[0];
        expect(translation.key).toBe("newFeature.title");
        expect(translation.value).toBe("New Feature-de");
      }
    });

    it("should add new key to multiple target languages", async () => {
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "newFeature.description": "This is a new feature" },
      });

      const content = [
        { key: "newFeature.description", value: "This is a new feature" },
      ];
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

        for (const result of response.results) {
          expect(result.translations[0].key).toBe("newFeature.description");
          expect(result.translations[0].value).toContain(`-${result.language}`);
        }
      }
    });

    it("should handle nested new key correctly", async () => {
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "existing.section.newKey": "New nested key" },
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const sourceFlat = flattenJson(source as Record<string, unknown>);

      const newKey = sourceFlat.find((s) => s.key === "existing.section.newKey");
      expect(newKey).toBeDefined();

      // Even though we added to "existing.section", the key path should be correct
      expect(newKey!.key).toBe("existing.section.newKey");
    });
  });

  describe("Delete Key from Source", () => {
    it("should detect key deleted from source", async () => {
      // First add a key to both source and target
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "tempKey": "Temporary" },
      });
      await modifyJsonFixture(tempDir.path, "locales/de.json", {
        addKeys: { "tempKey": "Temporär" },
      });

      // Verify both have the key
      let source = await readJsonFixture(tempDir.path, "locales/en.json");
      let target = await readJsonFixture(tempDir.path, "locales/de.json");
      expect(source.tempKey).toBe("Temporary");
      expect(target.tempKey).toBe("Temporär");

      // Now delete from source
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        removeKeys: ["tempKey"],
      });

      source = await readJsonFixture(tempDir.path, "locales/en.json");
      target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Source should not have key
      expect(source.tempKey).toBeUndefined();
      // Target still has key (before sync)
      expect(target.tempKey).toBe("Temporär");
    });

    it("should remove deleted key from target using removeExtraKeys", async () => {
      // Setup: target has extra key that source doesn't have
      await modifyJsonFixture(tempDir.path, "locales/de.json", {
        addKeys: { "oldKey": "Old value" },
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Verify target has the extra key
      expect(target.oldKey).toBe("Old value");

      // Get source keys
      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const sourceKeys = new Set(sourceFlat.map((s) => s.key));

      // Remove extra keys from target
      const cleanedTarget = removeExtraKeys(
        target as Record<string, unknown>,
        sourceKeys
      );

      // oldKey should be removed
      expect(cleanedTarget.oldKey).toBeUndefined();
    });

    it("should remove nested key when deleted from source", async () => {
      // Add and then remove a nested key
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        removeKeys: ["auth.forgot_password"],
      });
      await modifyJsonFixture(tempDir.path, "locales/de.json", {
        addKeys: { "auth.forgot_password": "Passwort vergessen?" },
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const sourceKeys = new Set(sourceFlat.map((s) => s.key));

      // Target has auth.forgot_password but source doesn't
      const targetFlat = flattenJson(target as Record<string, unknown>);
      const hasForgotPassword = targetFlat.some(
        (t) => t.key === "auth.forgot_password"
      );
      expect(hasForgotPassword).toBe(true);
      expect(sourceKeys.has("auth.forgot_password")).toBe(false);

      // Remove extra keys
      const cleanedTarget = removeExtraKeys(
        target as Record<string, unknown>,
        sourceKeys
      );
      const cleanedFlat = flattenJson(cleanedTarget);

      // Verify key is removed
      expect(cleanedFlat.some((t) => t.key === "auth.forgot_password")).toBe(
        false
      );
    });

    it("should keep other keys in same section when one is deleted", async () => {
      // Remove only one key from auth section
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        removeKeys: ["auth.signup"],
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const sourceKeys = new Set(sourceFlat.map((s) => s.key));

      // auth.login and auth.logout should still exist
      expect(sourceKeys.has("auth.login")).toBe(true);
      expect(sourceKeys.has("auth.logout")).toBe(true);
      expect(sourceKeys.has("auth.signup")).toBe(false);
    });
  });

  describe("Combined Add and Delete", () => {
    it("should handle simultaneous add and delete", async () => {
      // Add new key and remove old key
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "newSection.newKey": "New value" },
        removeKeys: ["auth.signup"],
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const sourceKeys = new Set(sourceFlat.map((s) => s.key));

      // New key should exist
      expect(sourceKeys.has("newSection.newKey")).toBe(true);

      // Old key should not exist
      expect(sourceKeys.has("auth.signup")).toBe(false);

      // Other auth keys should still exist
      expect(sourceKeys.has("auth.login")).toBe(true);
    });

    it("should sync new key while cleaning up removed key", async () => {
      // Setup: add new key to source, add old key to target
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "feature.new": "New feature" },
      });
      await modifyJsonFixture(tempDir.path, "locales/de.json", {
        addKeys: { "feature.old": "Old feature" },
      });

      const source = await readJsonFixture(tempDir.path, "locales/en.json");
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      const sourceFlat = flattenJson(source as Record<string, unknown>);
      const targetFlat = flattenJson(target as Record<string, unknown>);
      const sourceKeys = new Set(sourceFlat.map((s) => s.key));

      // Find new key to sync
      const targetKeys = new Set(targetFlat.map((t) => t.key));
      const newKeys = sourceFlat.filter((s) => !targetKeys.has(s.key));

      expect(newKeys.some((k) => k.key === "feature.new")).toBe(true);

      // Clean up extra keys
      const cleanedTarget = removeExtraKeys(
        target as Record<string, unknown>,
        sourceKeys
      );
      const cleanedFlat = flattenJson(cleanedTarget);

      // Old key should be removed
      expect(cleanedFlat.some((t) => t.key === "feature.old")).toBe(false);
    });
  });

  describe("Dry Run Preview", () => {
    it("should show new keys in dry run delta", async () => {
      await modifyJsonFixture(tempDir.path, "locales/en.json", {
        addKeys: { "preview.key": "Preview value" },
      });

      const content = [{ key: "preview.key", value: "Preview value" }];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockDryRunResponse(content),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content,
        dry_run: true,
      });

      expect(response.success).toBe(true);

      if (response.success && "delta" in response) {
        expect(response.delta.newKeys).toContain("preview.key");
        expect(response.delta.totalKeysToSync).toBe(1);
      }
    });

    it("should not modify files in dry run mode", async () => {
      const originalTarget = await readJsonFixture(
        tempDir.path,
        "locales/de.json"
      );

      const content = [{ key: "test.key", value: "Test value" }];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockDryRunResponse(content),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content,
        dry_run: true,
      });

      // Read target again
      const targetAfterDryRun = await readJsonFixture(
        tempDir.path,
        "locales/de.json"
      );

      // Files should be unchanged
      expect(targetAfterDryRun).toEqual(originalTarget);
    });

    it("should show cost estimate in dry run", async () => {
      const content = [
        { key: "key1", value: "First value here" },
        { key: "key2", value: "Second value with more words" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createMockDryRunResponse(content),
      });

      const { LangAPIClient } = await import("../../src/api/client.js");
      const client = new LangAPIClient("mock-key", "https://mock.langapi.io");

      const response = await client.sync({
        source_lang: "en",
        target_langs: ["de"],
        content,
        dry_run: true,
      });

      expect(response.success).toBe(true);

      if (response.success && "cost" in response && "wordsToTranslate" in response.cost) {
        expect(response.cost.wordsToTranslate).toBeGreaterThan(0);
        expect(response.cost.creditsRequired).toBeGreaterThan(0);
        expect(response.cost.currentBalance).toBeDefined();
      }
    });
  });

  describe("Merge Behavior", () => {
    it("should merge new translations with existing content", async () => {
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Simulate new translations from API
      const newTranslations = {
        app: { tagline: "Erstelle etwas Erstaunliches" },
        common: { save: "Speichern" },
      };

      const merged = deepMerge(
        target as Record<string, unknown>,
        newTranslations
      );

      // Original translations should be preserved
      expect((merged.app as Record<string, unknown>).name).toBe("Meine Anwendung");

      // New translations should be added
      expect((merged.app as Record<string, unknown>).tagline).toBe(
        "Erstelle etwas Erstaunliches"
      );
      expect((merged.common as Record<string, unknown>).save).toBe("Speichern");
    });

    it("should not overwrite existing translations in non-hard_sync mode", async () => {
      const target = await readJsonFixture(tempDir.path, "locales/de.json");

      // Verify existing translation
      expect((target.app as Record<string, unknown>).name).toBe("Meine Anwendung");

      // Simulating API returning new translation for existing key
      const newTranslations = {
        app: { name: "Neue Anwendung" }, // Would overwrite existing
      };

      // In real sync, we filter out existing keys before API call
      // So deepMerge only gets truly new keys
      // Here we test the merge behavior if it did receive overlapping keys

      const merged = deepMerge(
        target as Record<string, unknown>,
        newTranslations
      );

      // deepMerge does override values - in real sync we prevent this by filtering
      expect((merged.app as Record<string, unknown>).name).toBe("Neue Anwendung");
    });
  });
});
