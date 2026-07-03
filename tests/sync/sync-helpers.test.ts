/**
 * Tests for sync-translations pure helper functions
 */

import { describe, it, expect } from "vitest";
import { computeTargetFilePath, detectFileFormat } from "../../src/tools/sync-translations.js";

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

  describe("detectFileFormat", () => {
    it("should detect .arb files", () => {
      expect(detectFileFormat("/project/lib/l10n/app_en.arb")).toBe("arb");
    });

    it("should detect .strings files", () => {
      expect(detectFileFormat("/project/en.lproj/Localizable.strings")).toBe("strings");
    });

    it("should detect .stringsdict files", () => {
      expect(detectFileFormat("/project/en.lproj/Localizable.stringsdict")).toBe("stringsdict");
    });

    it("should detect .xcstrings files", () => {
      expect(detectFileFormat("/project/Localizable.xcstrings")).toBe("xcstrings");
    });

    it("should default to json for everything else", () => {
      expect(detectFileFormat("/project/locales/en.json")).toBe("json");
      expect(detectFileFormat("/project/locales/en/messages.json")).toBe("json");
    });
  });
});
