import { describe, it, expect } from "vitest";
import {
  isArbFile,
  isArbMetadataKey,
  isArbLocaleKey,
  parseArbContent,
  reconstructArbContent,
  mergeArbContent,
  getLocaleFileExtension,
} from "./arb-parser.js";

describe("ARB Parser", () => {
  describe("isArbFile", () => {
    it("should return true for .arb files", () => {
      expect(isArbFile("lib/l10n/app_en.arb")).toBe(true);
      expect(isArbFile("/absolute/path/to/intl_de.arb")).toBe(true);
      expect(isArbFile("simple.arb")).toBe(true);
    });

    it("should return false for non-ARB files", () => {
      expect(isArbFile("locales/en.json")).toBe(false);
      expect(isArbFile("file.arb.json")).toBe(false);
      expect(isArbFile("file.txt")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isArbFile("file.ARB")).toBe(true);
      expect(isArbFile("file.Arb")).toBe(true);
      expect(isArbFile("FILE.ARB")).toBe(true);
    });
  });

  describe("getLocaleFileExtension", () => {
    it("should return .arb for ARB files", () => {
      expect(getLocaleFileExtension("app_en.arb")).toBe(".arb");
      expect(getLocaleFileExtension("file.ARB")).toBe(".arb");
    });

    it("should return .json for non-ARB files", () => {
      expect(getLocaleFileExtension("en.json")).toBe(".json");
      expect(getLocaleFileExtension("file.txt")).toBe(".json");
      expect(getLocaleFileExtension("noextension")).toBe(".json");
    });
  });

  describe("isArbMetadataKey", () => {
    it("should return true for @ prefixed keys", () => {
      expect(isArbMetadataKey("@greeting")).toBe(true);
      expect(isArbMetadataKey("@@locale")).toBe(true);
      expect(isArbMetadataKey("@")).toBe(true);
    });

    it("should return false for regular keys", () => {
      expect(isArbMetadataKey("greeting")).toBe(false);
      expect(isArbMetadataKey("hello_world")).toBe(false);
      expect(isArbMetadataKey("")).toBe(false);
    });
  });

  describe("isArbLocaleKey", () => {
    it("should return true for @@locale", () => {
      expect(isArbLocaleKey("@@locale")).toBe(true);
    });

    it("should return false for other keys", () => {
      expect(isArbLocaleKey("@locale")).toBe(false);
      expect(isArbLocaleKey("@@other")).toBe(false);
      expect(isArbLocaleKey("locale")).toBe(false);
    });
  });

  describe("parseArbContent", () => {
    it("should separate translatable keys from metadata", () => {
      const arbData = {
        "@@locale": "en",
        greeting: "Hello, {name}!",
        "@greeting": {
          description: "A greeting message",
          placeholders: {
            name: { type: "String" },
          },
        },
        farewell: "Goodbye!",
      };

      const result = parseArbContent(arbData);

      expect(result.locale).toBe("en");
      expect(result.translatableKeys).toEqual([
        { key: "greeting", value: "Hello, {name}!" },
        { key: "farewell", value: "Goodbye!" },
      ]);
      expect(result.metadata["@@locale"]).toBe("en");
      expect(result.metadata["@greeting"]).toEqual({
        description: "A greeting message",
        placeholders: {
          name: { type: "String" },
        },
      });
    });

    it("should handle ARB files without metadata", () => {
      const arbData = {
        "@@locale": "en",
        hello: "Hello",
        world: "World",
      };

      const result = parseArbContent(arbData);

      expect(result.locale).toBe("en");
      expect(result.translatableKeys).toHaveLength(2);
      expect(Object.keys(result.metadata)).toEqual(["@@locale"]);
    });

    it("should handle ARB files without @@locale", () => {
      const arbData = {
        greeting: "Hello",
        "@greeting": { description: "A greeting" },
      };

      const result = parseArbContent(arbData);

      expect(result.locale).toBeNull();
      expect(result.translatableKeys).toEqual([{ key: "greeting", value: "Hello" }]);
      expect(result.metadata["@greeting"]).toEqual({ description: "A greeting" });
    });

    it("should skip non-string translatable values", () => {
      const arbData = {
        "@@locale": "en",
        validString: "Hello",
        invalidNumber: 123,
        invalidObject: { nested: "value" },
        "@validString": { description: "Valid" },
      };

      const result = parseArbContent(arbData as Record<string, unknown>);

      expect(result.translatableKeys).toEqual([{ key: "validString", value: "Hello" }]);
    });
  });

  describe("reconstructArbContent", () => {
    it("should reconstruct ARB with updated locale and preserved metadata", () => {
      const translations = [
        { key: "greeting", value: "Hallo, {name}!" },
        { key: "farewell", value: "Auf Wiedersehen!" },
      ];
      const metadata = {
        "@@locale": "en",
        "@greeting": { description: "A greeting message" },
      };

      const result = reconstructArbContent(translations, metadata, "de");

      expect(result["@@locale"]).toBe("de");
      expect(result["greeting"]).toBe("Hallo, {name}!");
      expect(result["@greeting"]).toEqual({ description: "A greeting message" });
      expect(result["farewell"]).toBe("Auf Wiedersehen!");
      // farewell has no metadata, so @farewell should not exist
      expect(result["@farewell"]).toBeUndefined();
    });

    it("should maintain key order: @@locale first, then key-metadata pairs", () => {
      const translations = [
        { key: "alpha", value: "Alpha" },
        { key: "beta", value: "Beta" },
      ];
      const metadata = {
        "@@locale": "en",
        "@alpha": { description: "First" },
        "@beta": { description: "Second" },
      };

      const result = reconstructArbContent(translations, metadata, "fr");
      const keys = Object.keys(result);

      expect(keys[0]).toBe("@@locale");
      expect(keys[1]).toBe("alpha");
      expect(keys[2]).toBe("@alpha");
      expect(keys[3]).toBe("beta");
      expect(keys[4]).toBe("@beta");
    });

    it("should handle empty metadata", () => {
      const translations = [{ key: "hello", value: "Bonjour" }];
      const metadata = { "@@locale": "en" };

      const result = reconstructArbContent(translations, metadata, "fr");

      expect(result["@@locale"]).toBe("fr");
      expect(result["hello"]).toBe("Bonjour");
      expect(Object.keys(result)).toHaveLength(2);
    });
  });

  describe("mergeArbContent", () => {
    it("should merge new translations with existing content", () => {
      const existingContent = {
        "@@locale": "de",
        greeting: "Hallo",
        "@greeting": { description: "A greeting" },
        farewell: "Tschüss",
      };
      const newTranslations = [
        { key: "greeting", value: "Hallo, {name}!" }, // Updated
      ];
      const sourceMetadata = {
        "@@locale": "en",
        "@greeting": { description: "A greeting message" },
        "@farewell": { description: "A farewell" },
      };
      const sourceKeys = new Set(["greeting", "farewell"]);

      const result = mergeArbContent(
        existingContent,
        newTranslations,
        sourceMetadata,
        sourceKeys,
        "de"
      );

      expect(result["@@locale"]).toBe("de");
      expect(result["greeting"]).toBe("Hallo, {name}!"); // New translation
      expect(result["farewell"]).toBe("Tschüss"); // Preserved existing
      expect(result["@greeting"]).toEqual({ description: "A greeting message" }); // Source metadata
      expect(result["@farewell"]).toEqual({ description: "A farewell" }); // Source metadata
    });

    it("should remove keys not in source", () => {
      const existingContent = {
        "@@locale": "de",
        greeting: "Hallo",
        oldKey: "Should be removed",
      };
      const newTranslations: Array<{ key: string; value: string }> = [];
      const sourceMetadata = { "@@locale": "en" };
      const sourceKeys = new Set(["greeting"]); // oldKey not in source

      const result = mergeArbContent(
        existingContent,
        newTranslations,
        sourceMetadata,
        sourceKeys,
        "de"
      );

      expect(result["greeting"]).toBe("Hallo");
      expect(result["oldKey"]).toBeUndefined(); // Removed
    });

    it("should handle empty existing content", () => {
      const existingContent = {};
      const newTranslations = [
        { key: "hello", value: "Bonjour" },
        { key: "world", value: "Monde" },
      ];
      const sourceMetadata = {
        "@@locale": "en",
        "@hello": { description: "Hello message" },
      };
      const sourceKeys = new Set(["hello", "world"]);

      const result = mergeArbContent(
        existingContent,
        newTranslations,
        sourceMetadata,
        sourceKeys,
        "fr"
      );

      expect(result["@@locale"]).toBe("fr");
      expect(result["hello"]).toBe("Bonjour");
      expect(result["world"]).toBe("Monde");
      expect(result["@hello"]).toEqual({ description: "Hello message" });
    });

    it("should preserve existing translations when no new translations provided", () => {
      const existingContent = {
        "@@locale": "de",
        greeting: "Hallo",
        farewell: "Tschüss",
      };
      const newTranslations: Array<{ key: string; value: string }> = [];
      const sourceMetadata = { "@@locale": "en" };
      const sourceKeys = new Set(["greeting", "farewell"]);

      const result = mergeArbContent(
        existingContent,
        newTranslations,
        sourceMetadata,
        sourceKeys,
        "de"
      );

      expect(result["greeting"]).toBe("Hallo");
      expect(result["farewell"]).toBe("Tschüss");
    });

    it("should use source metadata instead of existing metadata", () => {
      const existingContent = {
        "@@locale": "de",
        greeting: "Hallo",
        "@greeting": { description: "Old description" },
      };
      const newTranslations: Array<{ key: string; value: string }> = [];
      const sourceMetadata = {
        "@@locale": "en",
        "@greeting": { description: "New description from source" },
      };
      const sourceKeys = new Set(["greeting"]);

      const result = mergeArbContent(
        existingContent,
        newTranslations,
        sourceMetadata,
        sourceKeys,
        "de"
      );

      expect(result["@greeting"]).toEqual({ description: "New description from source" });
    });
  });
});
