import { describe, it, expect } from "vitest";
import {
  parseXCStringsContent,
  extractLocaleFromXCStrings,
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
});
