import { describe, it, expect } from "vitest";
import { parseStringsContent } from "./strings-parser.js";

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
});
