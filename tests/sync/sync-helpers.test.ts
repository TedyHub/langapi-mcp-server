/**
 * Tests for sync helper functions
 */

import { describe, it, expect } from "vitest";
import {
  computeTargetFilePath,
  deepMerge,
  removeExtraKeys,
  removeKeysFromObject,
  getSkipKeysForLang,
} from "../../src/tools/sync-translations.js";

describe("Sync Helper Functions", () => {
  describe("computeTargetFilePath", () => {
    it("should handle directory-based pattern (/en/ -> /de/)", () => {
      const result = computeTargetFilePath(
        "/project/locales/en/messages.json",
        "en",
        "de"
      );
      expect(result).toBe("/project/locales/de/messages.json");
    });

    it("should handle flat file pattern (/en.json -> /de.json)", () => {
      const result = computeTargetFilePath("/project/locales/en.json", "en", "de");
      expect(result).toBe("/project/locales/de.json");
    });

    it("should handle prefix pattern (messages.en.json -> messages.de.json)", () => {
      const result = computeTargetFilePath(
        "/project/messages.en.json",
        "en",
        "de"
      );
      expect(result).toBe("/project/messages.de.json");
    });

    it("should handle Flutter underscore pattern (app_en.arb -> app_de.arb)", () => {
      const result = computeTargetFilePath(
        "/project/lib/l10n/app_en.arb",
        "en",
        "de"
      );
      expect(result).toBe("/project/lib/l10n/app_de.arb");
    });

    it("should handle iOS lproj pattern (en.lproj -> de.lproj)", () => {
      const result = computeTargetFilePath(
        "/project/en.lproj/Localizable.strings",
        "en",
        "de"
      );
      expect(result).toBe("/project/de.lproj/Localizable.strings");
    });

    it("should return same path for xcstrings files", () => {
      const result = computeTargetFilePath(
        "/project/Localizable.xcstrings",
        "en",
        "de"
      );
      expect(result).toBe("/project/Localizable.xcstrings");
    });

    it("should handle complex language codes (pt-BR -> es-MX)", () => {
      const result = computeTargetFilePath(
        "/project/locales/pt-BR/messages.json",
        "pt-BR",
        "es-MX"
      );
      expect(result).toBe("/project/locales/es-MX/messages.json");
    });

    it("should return null when pattern cannot be determined", () => {
      const result = computeTargetFilePath(
        "/project/random/file.json",
        "en",
        "de"
      );
      expect(result).toBeNull();
    });
  });

  describe("deepMerge", () => {
    it("should merge nested objects", () => {
      const target = { a: { b: 1 } };
      const source = { a: { c: 2 } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { b: 1, c: 2 } });
    });

    it("should override primitive values", () => {
      const target = { a: 1 };
      const source = { a: 2 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 2 });
    });

    it("should add new keys from source", () => {
      const target = { a: 1 };
      const source = { b: 2 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should handle deeply nested objects", () => {
      const target = { a: { b: { c: 1 } } };
      const source = { a: { b: { d: 2 } } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { b: { c: 1, d: 2 } } });
    });

    it("should not mutate original objects", () => {
      const target = { a: 1 };
      const source = { b: 2 };
      deepMerge(target, source);
      expect(target).toEqual({ a: 1 });
      expect(source).toEqual({ b: 2 });
    });

    it("should override arrays (not merge them)", () => {
      const target = { arr: [1, 2] };
      const source = { arr: [3, 4] };
      const result = deepMerge(target, source);
      expect(result).toEqual({ arr: [3, 4] });
    });
  });

  describe("removeKeysFromObject", () => {
    it("should remove top-level keys", () => {
      const obj = { a: 1, b: 2, c: 3 };
      const result = removeKeysFromObject(obj, ["b"]);
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it("should remove nested keys with dot notation", () => {
      const obj = { section: { a: 1, b: 2 } };
      const result = removeKeysFromObject(obj, ["section.b"]);
      expect(result).toEqual({ section: { a: 1 } });
    });

    it("should remove deeply nested keys", () => {
      const obj = { l1: { l2: { l3: { a: 1, b: 2 } } } };
      const result = removeKeysFromObject(obj, ["l1.l2.l3.a"]);
      expect(result).toEqual({ l1: { l2: { l3: { b: 2 } } } });
    });

    it("should handle non-existent keys gracefully", () => {
      const obj = { a: 1 };
      const result = removeKeysFromObject(obj, ["nonexistent", "also.nonexistent"]);
      expect(result).toEqual({ a: 1 });
    });

    it("should not mutate original object", () => {
      const obj = { a: 1, b: 2 };
      removeKeysFromObject(obj, ["a"]);
      expect(obj).toEqual({ a: 1, b: 2 });
    });
  });

  describe("removeExtraKeys", () => {
    it("should remove keys not in source", () => {
      const target = { a: 1, b: 2, c: 3 };
      const sourceKeys = new Set(["a", "b"]);
      const result = removeExtraKeys(target, sourceKeys);
      expect(result).toEqual({ a: 1, b: 2 });
      expect(result).not.toHaveProperty("c");
    });

    it("should handle nested keys", () => {
      const target = { section: { a: 1, b: 2 } };
      const sourceKeys = new Set(["section.a"]);
      const result = removeExtraKeys(target, sourceKeys);
      expect(result.section).toEqual({ a: 1 });
    });

    it("should return unchanged object if no extra keys", () => {
      const target = { a: 1, b: 2 };
      const sourceKeys = new Set(["a", "b"]);
      const result = removeExtraKeys(target, sourceKeys);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should remove all keys if source is empty", () => {
      const target = { a: 1, b: 2 };
      const sourceKeys = new Set<string>();
      const result = removeExtraKeys(target, sourceKeys);
      expect(result).toEqual({});
    });
  });

  describe("getSkipKeysForLang", () => {
    it("should return keys for specified language", () => {
      const skipKeys = { fr: ["key1", "key2"], de: ["key3"] };
      const result = getSkipKeysForLang(skipKeys, "fr");
      expect(result).toEqual(new Set(["key1", "key2"]));
    });

    it("should return empty set for language not in skipKeys", () => {
      const skipKeys = { fr: ["key1"] };
      const result = getSkipKeysForLang(skipKeys, "de");
      expect(result).toEqual(new Set());
    });

    it("should return empty set when skipKeys is undefined", () => {
      const result = getSkipKeysForLang(undefined, "fr");
      expect(result).toEqual(new Set());
    });

    it("should return empty set for empty language array", () => {
      const skipKeys = { fr: [] };
      const result = getSkipKeysForLang(skipKeys, "fr");
      expect(result).toEqual(new Set());
    });
  });
});
