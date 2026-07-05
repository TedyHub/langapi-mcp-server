import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadGlossary, glossaryTermsForLanguage } from "./glossary.js";

const CSV = `source_term,category,do_not_translate,part_of_speech,definition,avoid_wrong_senses,strategy,language,target_term,confidence
PIN,do-not-translate,yes,,"Security code, keep it",,do-not-translate,ALL,PIN,high
Token,term,yes,,,,keep-english,ALL,Token,high
Token,term,no,,,,keep-english,ru,токен,verified
Quote,term,no,,,,translate,ALL,,needs-native-review
Quote,term,no,,,,translate,es,cotización,verified
Quote,term,no,,,,translate,de,Kurs,verified
`;

const JSON_GLOSSARY = JSON.stringify({
  doNotTranslate: [{ term: "PIN" }, { term: "OPINDEX", aliases: ["Opindex"] }],
  terms: [
    { source: "Token", strategy: "keep-english", targets: { ru: "токен" } },
    { source: "Quote", strategy: "translate", targets: { es: "cotización", de: "Kurs" } },
  ],
});

const csvPath = join(tmpdir(), `glossary-test-${process.pid}.csv`);
const jsonPath = join(tmpdir(), `glossary-test-${process.pid}.json`);

beforeAll(async () => {
  await writeFile(csvPath, CSV, "utf-8");
  await writeFile(jsonPath, JSON_GLOSSARY, "utf-8");
});
afterAll(async () => {
  await rm(csvPath, { force: true });
  await rm(jsonPath, { force: true });
});

function asMap(terms: { source_text: string; target_text: string }[]): Record<string, string> {
  return Object.fromEntries(terms.map((t) => [t.source_text, t.target_text]));
}

describe("glossary CSV", () => {
  it("applies do-not-translate everywhere and honors exact-over-ALL + confidence policy", async () => {
    const g = await loadGlossary(csvPath);

    const ru = asMap(glossaryTermsForLanguage(g, "ru"));
    expect(ru.PIN).toBe("PIN"); // kept verbatim
    expect(ru.Token).toBe("токен"); // ru override beats the ALL keep
    expect(ru.Quote).toBeUndefined(); // no ru target, ALL is blank → skipped

    const de = asMap(glossaryTermsForLanguage(g, "de"));
    expect(de.PIN).toBe("PIN");
    expect(de.Token).toBe("Token"); // no de override → keep
    expect(de.Quote).toBe("Kurs");

    const th = asMap(glossaryTermsForLanguage(g, "th"));
    expect(th.PIN).toBe("PIN");
    expect(th.Token).toBe("Token");
    expect(th.Quote).toBeUndefined(); // unverified language: never auto-filled
  });
});

describe("glossary JSON", () => {
  it("expands doNotTranslate (+aliases), keep-english, and translate targets", async () => {
    const g = await loadGlossary(jsonPath);

    const ru = asMap(glossaryTermsForLanguage(g, "ru"));
    expect(ru.PIN).toBe("PIN");
    expect(ru.OPINDEX).toBe("OPINDEX");
    expect(ru.Opindex).toBe("Opindex"); // alias kept too
    expect(ru.Token).toBe("токен");
    expect(ru.Quote).toBeUndefined();

    const de = asMap(glossaryTermsForLanguage(g, "de"));
    expect(de.Token).toBe("Token");
    expect(de.Quote).toBe("Kurs");

    const th = asMap(glossaryTermsForLanguage(g, "th"));
    expect(th.PIN).toBe("PIN");
    expect(th.Quote).toBeUndefined();
  });
});
