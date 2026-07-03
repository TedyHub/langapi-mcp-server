import { describe, it, expect } from "vitest";
import { parseStringsDictContent } from "./stringsdict-parser.js";

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
});
