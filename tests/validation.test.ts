import { describe, it, expect } from "vitest";
import { languageCodeSchema, isValidLanguageCode } from "../src/utils/validation.js";

describe("languageCodeSchema", () => {
  it("accepts base, region, and script subtags", () => {
    for (const code of ["en", "de", "fra", "pt-BR", "zh-CN", "zh-TW", "zh-Hant", "zh-Hans"]) {
      expect(languageCodeSchema.safeParse(code).success, code).toBe(true);
      expect(isValidLanguageCode(code), code).toBe(true);
    }
  });

  it("rejects malformed codes", () => {
    for (const code of ["EN", "e", "en-us", "zh-hant", "zh_CN", "toolonglang", "en-USA"]) {
      expect(languageCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});
