import { describe, it, expect } from "vitest";
import {
  parseXCStringsContent,
  extractLocaleFromXCStrings,
  updateXCStringsLocale,
  mergeXCStringsContent,
  reconstructXCStringsContent,
  getXCStringsLanguages,
  type XCStringsFile,
} from "./xcstrings-parser.js";

describe("XCStrings Parser", () => {
  const sampleXCStrings: XCStringsFile = {
    sourceLanguage: "en",
    version: "1.0",
    strings: {
      greeting: {
        localizations: {
          en: { stringUnit: { state: "translated", value: "Hello" } },
          de: { stringUnit: { state: "translated", value: "Hallo" } },
        },
      },
      farewell: {
        localizations: {
          en: { stringUnit: { state: "translated", value: "Goodbye" } },
        },
      },
    },
  };

  describe("parseXCStringsContent", () => {
    it("should parse source language", () => {
      const content = JSON.stringify(sampleXCStrings);
      const result = parseXCStringsContent(content);

      expect(result).not.toBeNull();
      expect(result!.sourceLanguage).toBe("en");
    });

    it("should extract all localizations", () => {
      const content = JSON.stringify(sampleXCStrings);
      const result = parseXCStringsContent(content);

      expect(result).not.toBeNull();
      expect(result!.allLocalizations.has("en")).toBe(true);
      expect(result!.allLocalizations.has("de")).toBe(true);
    });

    it("should extract source language entries", () => {
      const content = JSON.stringify(sampleXCStrings);
      const result = parseXCStringsContent(content);

      expect(result).not.toBeNull();
      expect(result!.entries).toEqual([
        { key: "greeting", value: "Hello" },
        { key: "farewell", value: "Goodbye" },
      ]);
    });

    it("should handle missing localizations", () => {
      const xcstrings: XCStringsFile = {
        sourceLanguage: "en",
        version: "1.0",
        strings: {
          key: {},
        },
      };
      const result = parseXCStringsContent(JSON.stringify(xcstrings));

      expect(result).not.toBeNull();
      expect(result!.entries).toEqual([]);
    });

    it("should return null for invalid JSON", () => {
      const result = parseXCStringsContent("invalid json");
      expect(result).toBeNull();
    });

    it("should return null for missing required fields", () => {
      const result = parseXCStringsContent("{}");
      expect(result).toBeNull();
    });

    it("should preserve metadata", () => {
      const content = JSON.stringify(sampleXCStrings);
      const result = parseXCStringsContent(content);

      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual(sampleXCStrings);
    });
  });

  describe("extractLocaleFromXCStrings", () => {
    it("should extract specific locale translations", () => {
      const result = extractLocaleFromXCStrings(sampleXCStrings, "en");

      expect(result).toEqual([
        { key: "greeting", value: "Hello" },
        { key: "farewell", value: "Goodbye" },
      ]);
    });

    it("should return empty for missing locale", () => {
      const result = extractLocaleFromXCStrings(sampleXCStrings, "fr");
      expect(result).toEqual([]);
    });

    it("should handle partial translations", () => {
      const result = extractLocaleFromXCStrings(sampleXCStrings, "de");

      expect(result).toEqual([{ key: "greeting", value: "Hallo" }]);
    });
  });

  describe("getXCStringsLanguages", () => {
    it("should return all language codes", () => {
      const result = getXCStringsLanguages(sampleXCStrings);

      expect(result).toContain("en");
      expect(result).toContain("de");
      expect(result.size).toBe(2);
    });
  });

  describe("updateXCStringsLocale", () => {
    it("should add new locale translations", () => {
      const translations = [
        { key: "greeting", value: "Bonjour" },
        { key: "farewell", value: "Au revoir" },
      ];

      const result = updateXCStringsLocale(sampleXCStrings, "fr", translations);

      expect(result.strings.greeting.localizations?.fr?.stringUnit?.value).toBe(
        "Bonjour"
      );
      expect(result.strings.farewell.localizations?.fr?.stringUnit?.value).toBe(
        "Au revoir"
      );
    });

    it("should update existing locale", () => {
      const translations = [{ key: "greeting", value: "Guten Tag" }];

      const result = updateXCStringsLocale(sampleXCStrings, "de", translations);

      expect(result.strings.greeting.localizations?.de?.stringUnit?.value).toBe(
        "Guten Tag"
      );
    });

    it("should set state to translated", () => {
      const translations = [{ key: "greeting", value: "Bonjour" }];

      const result = updateXCStringsLocale(sampleXCStrings, "fr", translations);

      expect(result.strings.greeting.localizations?.fr?.stringUnit?.state).toBe(
        "translated"
      );
    });

    it("should preserve other locales", () => {
      const translations = [{ key: "greeting", value: "Bonjour" }];

      const result = updateXCStringsLocale(sampleXCStrings, "fr", translations);

      expect(result.strings.greeting.localizations?.en?.stringUnit?.value).toBe(
        "Hello"
      );
      expect(result.strings.greeting.localizations?.de?.stringUnit?.value).toBe(
        "Hallo"
      );
    });

    it("should not modify original object", () => {
      const translations = [{ key: "greeting", value: "Bonjour" }];

      updateXCStringsLocale(sampleXCStrings, "fr", translations);

      expect(
        sampleXCStrings.strings.greeting.localizations?.fr
      ).toBeUndefined();
    });
  });

  describe("mergeXCStringsContent", () => {
    it("should merge without affecting other languages", () => {
      const translations = [{ key: "greeting", value: "Hola" }];
      const sourceKeys = new Set(["greeting", "farewell"]);

      const result = mergeXCStringsContent(
        sampleXCStrings,
        "es",
        translations,
        sourceKeys
      );

      expect(result.strings.greeting.localizations?.es?.stringUnit?.value).toBe(
        "Hola"
      );
      expect(result.strings.greeting.localizations?.en?.stringUnit?.value).toBe(
        "Hello"
      );
    });

    it("should remove deleted keys from all locales", () => {
      const translations: Array<{ key: string; value: string }> = [];
      const sourceKeys = new Set(["greeting"]); // farewell removed from source

      const result = mergeXCStringsContent(
        sampleXCStrings,
        "de",
        translations,
        sourceKeys
      );

      expect(result.strings.farewell).toBeUndefined();
      expect(result.strings.greeting).toBeDefined();
    });
  });

  describe("reconstructXCStringsContent", () => {
    it("should generate valid JSON", () => {
      const result = reconstructXCStringsContent(sampleXCStrings);
      const parsed = JSON.parse(result);

      expect(parsed.sourceLanguage).toBe("en");
      expect(parsed.version).toBe("1.0");
    });

    it("should have trailing newline", () => {
      const result = reconstructXCStringsContent(sampleXCStrings);
      expect(result.endsWith("\n")).toBe(true);
    });
  });
});
