import { describe, it, expect } from "vitest";
import { isArbFile, getLocaleFileExtension } from "./arb-parser.js";

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
});
