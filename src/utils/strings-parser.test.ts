import { describe, it, expect } from "vitest";
import {
  parseStringsContent,
  reconstructStringsContent,
  mergeStringsContent,
  escapeStringsValue,
} from "./strings-parser.js";

describe("Strings Parser", () => {
  describe("parseStringsContent", () => {
    it("should parse simple key-value pairs", () => {
      const content = `"greeting" = "Hello";
"farewell" = "Goodbye";`;

      const result = parseStringsContent(content);

      expect(result.entries).toEqual([
        { key: "greeting", value: "Hello" },
        { key: "farewell", value: "Goodbye" },
      ]);
    });

    it("should handle escaped quotes", () => {
      const content = `"message" = "He said \\"Hello\\"";`;

      const result = parseStringsContent(content);

      expect(result.entries).toEqual([
        { key: "message", value: 'He said "Hello"' },
      ]);
    });

    it("should handle escaped special characters", () => {
      const content = `"message" = "Line1\\nLine2\\tTabbed";`;

      const result = parseStringsContent(content);

      expect(result.entries).toEqual([
        { key: "message", value: "Line1\nLine2\tTabbed" },
      ]);
    });

    it("should preserve comments above entries", () => {
      const content = `/* User greeting */
"greeting" = "Hello";
/* User farewell */
"farewell" = "Goodbye";`;

      const result = parseStringsContent(content);

      expect(result.entries).toHaveLength(2);
      expect(result.comments.get("greeting")).toBe("User greeting");
      expect(result.comments.get("farewell")).toBe("User farewell");
    });

    it("should handle empty file", () => {
      const result = parseStringsContent("");

      expect(result.entries).toEqual([]);
      expect(result.comments.size).toBe(0);
    });

    it("should handle file-level header comment", () => {
      const content = `/* Copyright 2024 Company */
"greeting" = "Hello";`;

      const result = parseStringsContent(content);

      expect(result.headerComment).toBe("Copyright 2024 Company");
      expect(result.entries).toHaveLength(1);
    });

    it("should handle line comments", () => {
      const content = `// This is a greeting
"greeting" = "Hello";`;

      const result = parseStringsContent(content);

      expect(result.comments.get("greeting")).toBe("This is a greeting");
    });

    it("should parse Unicode escape sequences", () => {
      const content = `"char" = "caf\\U00E9";`;

      const result = parseStringsContent(content);

      expect(result.entries).toEqual([
        { key: "char", value: "café" },
      ]);
    });
  });

  describe("escapeStringsValue", () => {
    it("should escape quotes", () => {
      expect(escapeStringsValue('Say "Hello"')).toBe('Say \\"Hello\\"');
    });

    it("should escape newlines and tabs", () => {
      expect(escapeStringsValue("Line1\nLine2")).toBe("Line1\\nLine2");
      expect(escapeStringsValue("Col1\tCol2")).toBe("Col1\\tCol2");
    });

    it("should escape backslashes", () => {
      expect(escapeStringsValue("path\\to\\file")).toBe("path\\\\to\\\\file");
    });
  });

  describe("reconstructStringsContent", () => {
    it("should rebuild with proper formatting", () => {
      const entries = [
        { key: "greeting", value: "Hello" },
        { key: "farewell", value: "Goodbye" },
      ];
      const comments = new Map<string, string>();

      const result = reconstructStringsContent(entries, comments, null);

      expect(result).toBe('"greeting" = "Hello";\n"farewell" = "Goodbye";\n');
    });

    it("should preserve comments", () => {
      const entries = [{ key: "greeting", value: "Hello" }];
      const comments = new Map([["greeting", "User greeting"]]);

      const result = reconstructStringsContent(entries, comments, null);

      expect(result).toBe('/* User greeting */\n"greeting" = "Hello";\n');
    });

    it("should add header comment", () => {
      const entries = [{ key: "key", value: "value" }];
      const comments = new Map<string, string>();

      const result = reconstructStringsContent(entries, comments, "Header");

      expect(result).toContain("/* Header */");
    });

    it("should escape special characters in output", () => {
      const entries = [{ key: "msg", value: 'Say "Hi"\nOK' }];
      const comments = new Map<string, string>();

      const result = reconstructStringsContent(entries, comments, null);

      expect(result).toBe('"msg" = "Say \\"Hi\\"\\nOK";\n');
    });
  });

  describe("mergeStringsContent", () => {
    it("should merge new translations", () => {
      const existing = '"greeting" = "Hallo";';
      const newTranslations = [{ key: "farewell", value: "Auf Wiedersehen" }];
      const sourceComments = new Map<string, string>();
      const sourceKeys = new Set(["greeting", "farewell"]);

      const result = mergeStringsContent(
        existing,
        newTranslations,
        sourceComments,
        sourceKeys
      );

      expect(result).toContain('"greeting" = "Hallo"');
      expect(result).toContain('"farewell" = "Auf Wiedersehen"');
    });

    it("should preserve existing translations not updated", () => {
      const existing = '"greeting" = "Hallo";\n"farewell" = "Tschüss";';
      const newTranslations = [{ key: "greeting", value: "Guten Tag" }];
      const sourceComments = new Map<string, string>();
      const sourceKeys = new Set(["greeting", "farewell"]);

      const result = mergeStringsContent(
        existing,
        newTranslations,
        sourceComments,
        sourceKeys
      );

      expect(result).toContain('"greeting" = "Guten Tag"');
      expect(result).toContain('"farewell" = "Tschüss"');
    });

    it("should remove keys not in source", () => {
      const existing = '"greeting" = "Hallo";\n"deleted" = "To be removed";';
      const newTranslations: Array<{ key: string; value: string }> = [];
      const sourceComments = new Map<string, string>();
      const sourceKeys = new Set(["greeting"]);

      const result = mergeStringsContent(
        existing,
        newTranslations,
        sourceComments,
        sourceKeys
      );

      expect(result).toContain('"greeting" = "Hallo"');
      expect(result).not.toContain("deleted");
    });

    it("should preserve comment associations from source", () => {
      const existing = '"greeting" = "Hallo";';
      const newTranslations: Array<{ key: string; value: string }> = [];
      const sourceComments = new Map([["greeting", "User greeting"]]);
      const sourceKeys = new Set(["greeting"]);

      const result = mergeStringsContent(
        existing,
        newTranslations,
        sourceComments,
        sourceKeys
      );

      expect(result).toContain("/* User greeting */");
    });
  });
});
