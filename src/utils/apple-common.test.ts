import { describe, it, expect } from "vitest";
import {
  isStringsFile,
  isXCStringsFile,
  isStringsDictFile,
  detectAppleFileType,
  isAppleLocalizationFile,
  extractLanguageFromLproj,
  computeAppleLprojTargetPath,
} from "./apple-common.js";

describe("Apple Common Utilities", () => {
  describe("isStringsFile", () => {
    it("should return true for .strings files", () => {
      expect(isStringsFile("Localizable.strings")).toBe(true);
      expect(isStringsFile("/path/to/en.lproj/Localizable.strings")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isStringsFile("Localizable.STRINGS")).toBe(true);
      expect(isStringsFile("file.Strings")).toBe(true);
    });

    it("should return false for other files", () => {
      expect(isStringsFile("file.json")).toBe(false);
      expect(isStringsFile("file.xcstrings")).toBe(false);
    });
  });

  describe("isXCStringsFile", () => {
    it("should return true for .xcstrings files", () => {
      expect(isXCStringsFile("Localizable.xcstrings")).toBe(true);
      expect(isXCStringsFile("/path/to/Localizable.xcstrings")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isXCStringsFile("File.XCSTRINGS")).toBe(true);
    });

    it("should return false for other files", () => {
      expect(isXCStringsFile("file.strings")).toBe(false);
      expect(isXCStringsFile("file.json")).toBe(false);
    });
  });

  describe("isStringsDictFile", () => {
    it("should return true for .stringsdict files", () => {
      expect(isStringsDictFile("Localizable.stringsdict")).toBe(true);
      expect(isStringsDictFile("/path/to/en.lproj/Localizable.stringsdict")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isStringsDictFile("File.STRINGSDICT")).toBe(true);
    });

    it("should return false for other files", () => {
      expect(isStringsDictFile("file.strings")).toBe(false);
      expect(isStringsDictFile("file.json")).toBe(false);
    });
  });

  describe("detectAppleFileType", () => {
    it("should detect .strings files", () => {
      expect(detectAppleFileType("Localizable.strings")).toBe("strings");
    });

    it("should detect .xcstrings files", () => {
      expect(detectAppleFileType("Localizable.xcstrings")).toBe("xcstrings");
    });

    it("should detect .stringsdict files", () => {
      expect(detectAppleFileType("Localizable.stringsdict")).toBe("stringsdict");
    });

    it("should return null for non-Apple files", () => {
      expect(detectAppleFileType("file.json")).toBeNull();
      expect(detectAppleFileType("file.arb")).toBeNull();
    });
  });

  describe("isAppleLocalizationFile", () => {
    it("should return true for Apple files", () => {
      expect(isAppleLocalizationFile("file.strings")).toBe(true);
      expect(isAppleLocalizationFile("file.xcstrings")).toBe(true);
      expect(isAppleLocalizationFile("file.stringsdict")).toBe(true);
    });

    it("should return false for non-Apple files", () => {
      expect(isAppleLocalizationFile("file.json")).toBe(false);
      expect(isAppleLocalizationFile("file.arb")).toBe(false);
    });
  });

  describe("extractLanguageFromLproj", () => {
    it("should extract language from en.lproj path", () => {
      expect(extractLanguageFromLproj("/Project/en.lproj/Localizable.strings")).toBe("en");
    });

    it("should handle regional codes like pt-BR.lproj", () => {
      expect(extractLanguageFromLproj("/Project/pt-BR.lproj/Localizable.strings")).toBe("pt-BR");
      expect(extractLanguageFromLproj("/Project/zh-Hans.lproj/Main.strings")).toBe("zh-Hans");
    });

    it("should return null for Base.lproj", () => {
      expect(extractLanguageFromLproj("/Project/Base.lproj/Localizable.strings")).toBeNull();
    });

    it("should return null for non-lproj paths", () => {
      expect(extractLanguageFromLproj("/Project/locales/en/file.json")).toBeNull();
      expect(extractLanguageFromLproj("/Project/en/file.strings")).toBeNull();
    });

    it("should handle case-insensitive matching", () => {
      expect(extractLanguageFromLproj("/Project/EN.lproj/file.strings")).toBe("EN");
    });
  });

  describe("computeAppleLprojTargetPath", () => {
    it("should compute correct target for .lproj structure", () => {
      const result = computeAppleLprojTargetPath(
        "/Project/en.lproj/Localizable.strings",
        "en",
        "de"
      );
      expect(result).toBe("/Project/de.lproj/Localizable.strings");
    });

    it("should handle nested paths", () => {
      const result = computeAppleLprojTargetPath(
        "/Project/Resources/en.lproj/Main.strings",
        "en",
        "fr"
      );
      expect(result).toBe("/Project/Resources/fr.lproj/Main.strings");
    });

    it("should handle regional codes", () => {
      const result = computeAppleLprojTargetPath(
        "/Project/pt-BR.lproj/Localizable.strings",
        "pt-BR",
        "es-MX"
      );
      expect(result).toBe("/Project/es-MX.lproj/Localizable.strings");
    });

    it("should return null for non-lproj paths", () => {
      const result = computeAppleLprojTargetPath(
        "/Project/locales/en/file.json",
        "en",
        "de"
      );
      expect(result).toBeNull();
    });
  });
});
