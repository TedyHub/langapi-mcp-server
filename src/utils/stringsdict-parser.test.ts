import { describe, it, expect } from "vitest";
import {
  parseStringsDictContent,
  flattenStringsDictForApi,
  unflattenStringsDictFromApi,
  reconstructStringsDictContent,
  mergeStringsDictContent,
  type StringsDictEntry,
} from "./stringsdict-parser.js";

describe("Stringsdict Parser", () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items_count</key>
    <dict>
        <key>NSStringLocalizedFormatKey</key>
        <string>%#@count@</string>
        <key>count</key>
        <dict>
            <key>NSStringFormatSpecTypeKey</key>
            <string>NSStringPluralRuleType</string>
            <key>one</key>
            <string>%d item</string>
            <key>other</key>
            <string>%d items</string>
        </dict>
    </dict>
</dict>
</plist>`;

  describe("parseStringsDictContent", () => {
    it("should parse plural rules", () => {
      const result = parseStringsDictContent(sampleXml);

      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].key).toBe("items_count");
    });

    it("should extract NSStringLocalizedFormatKey", () => {
      const result = parseStringsDictContent(sampleXml);

      expect(result!.entries[0].formatKey).toBe("%#@count@");
    });

    it("should handle multiple plural variants", () => {
      const result = parseStringsDictContent(sampleXml);

      const entry = result!.entries[0];
      const rule = entry.pluralRules["count"];

      expect(rule.variants.one).toBe("%d item");
      expect(rule.variants.other).toBe("%d items");
    });

    it("should parse nested dict structure", () => {
      const result = parseStringsDictContent(sampleXml);

      const entry = result!.entries[0];
      expect(entry.pluralRules["count"]).toBeDefined();
      expect(entry.pluralRules["count"].specTypeKey).toBe("NSStringPluralRuleType");
    });

    it("should return null for invalid XML", () => {
      const result = parseStringsDictContent("invalid xml");
      expect(result).toBeNull();
    });

    it("should handle empty plist", () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
</dict>
</plist>`;
      const result = parseStringsDictContent(emptyXml);

      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(0);
    });
  });

  describe("flattenStringsDictForApi", () => {
    it("should flatten plural entries with dot notation", () => {
      const entries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: {
                one: "%d item",
                other: "%d items",
              },
            },
          },
        },
      ];

      const result = flattenStringsDictForApi(entries);

      expect(result).toContainEqual({
        key: "items_count.count.one",
        value: "%d item",
      });
      expect(result).toContainEqual({
        key: "items_count.count.other",
        value: "%d items",
      });
    });

    it("should include format key", () => {
      const entries: StringsDictEntry[] = [
        {
          key: "test",
          formatKey: "%#@var@",
          pluralRules: {},
        },
      ];

      const result = flattenStringsDictForApi(entries);

      expect(result).toContainEqual({
        key: "test.__formatKey",
        value: "%#@var@",
      });
    });
  });

  describe("unflattenStringsDictFromApi", () => {
    it("should reconstruct plural structure", () => {
      const translations = [
        { key: "items_count.count.one", value: "%d Artikel" },
        { key: "items_count.count.other", value: "%d Artikel" },
      ];

      const sourceEntries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { one: "%d item", other: "%d items" },
            },
          },
        },
      ];

      const result = unflattenStringsDictFromApi(translations, sourceEntries);

      expect(result[0].pluralRules.count.variants.one).toBe("%d Artikel");
      expect(result[0].pluralRules.count.variants.other).toBe("%d Artikel");
    });

    it("should handle missing variants", () => {
      const translations = [
        { key: "items_count.count.one", value: "%d Artikel" },
        // 'other' is missing
      ];

      const sourceEntries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { one: "%d item", other: "%d items" },
            },
          },
        },
      ];

      const result = unflattenStringsDictFromApi(translations, sourceEntries);

      expect(result[0].pluralRules.count.variants.one).toBe("%d Artikel");
      expect(result[0].pluralRules.count.variants.other).toBe("%d items"); // Kept from source
    });
  });

  describe("reconstructStringsDictContent", () => {
    it("should generate valid XML plist", () => {
      const entries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { one: "%d item", other: "%d items" },
            },
          },
        },
      ];

      const result = reconstructStringsDictContent(entries);

      expect(result).toContain('<?xml version="1.0"');
      expect(result).toContain("<plist version=\"1.0\">");
      expect(result).toContain("<key>items_count</key>");
      expect(result).toContain("<key>NSStringLocalizedFormatKey</key>");
      expect(result).toContain("<string>%#@count@</string>");
    });

    it("should maintain proper element order", () => {
      const entries: StringsDictEntry[] = [
        {
          key: "test",
          formatKey: "%#@var@",
          pluralRules: {
            var: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { zero: "none", one: "one", other: "many" },
            },
          },
        },
      ];

      const result = reconstructStringsDictContent(entries);

      // Variants should be in consistent order
      const zeroIndex = result.indexOf("<key>zero</key>");
      const oneIndex = result.indexOf("<key>one</key>");
      const otherIndex = result.indexOf("<key>other</key>");

      expect(zeroIndex).toBeLessThan(oneIndex);
      expect(oneIndex).toBeLessThan(otherIndex);
    });

    it("should have trailing newline", () => {
      const entries: StringsDictEntry[] = [];
      const result = reconstructStringsDictContent(entries);

      expect(result.endsWith("\n")).toBe(true);
    });
  });

  describe("mergeStringsDictContent", () => {
    it("should merge new translations", () => {
      const existing = sampleXml;
      const newTranslations = [
        { key: "items_count.count.one", value: "%d Artikel" },
        { key: "items_count.count.other", value: "%d Artikel" },
      ];

      const sourceEntries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { one: "%d item", other: "%d items" },
            },
          },
        },
      ];

      const sourceKeys = new Set(["items_count"]);

      const result = mergeStringsDictContent(
        existing,
        newTranslations,
        sourceEntries,
        sourceKeys
      );

      expect(result).toContain("%d Artikel");
    });

    it("should handle empty existing content", () => {
      const newTranslations = [
        { key: "items_count.count.one", value: "%d élément" },
        { key: "items_count.count.other", value: "%d éléments" },
      ];

      const sourceEntries: StringsDictEntry[] = [
        {
          key: "items_count",
          formatKey: "%#@count@",
          pluralRules: {
            count: {
              specTypeKey: "NSStringPluralRuleType",
              variants: { one: "%d item", other: "%d items" },
            },
          },
        },
      ];

      const sourceKeys = new Set(["items_count"]);

      const result = mergeStringsDictContent(
        "",
        newTranslations,
        sourceEntries,
        sourceKeys
      );

      expect(result).toContain("%d élément");
      expect(result).toContain("%d éléments");
    });
  });
});
