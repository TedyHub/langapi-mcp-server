/**
 * Glossary loading for sync_translations.
 *
 * A project keeps its glossary in-repo (the source of truth). This reads it and,
 * for a given target language, produces the inline terms to attach to that
 * language's translate-file request. The server applies them and never stores
 * anything. Two formats are supported:
 *
 *  - CSV: columns `source_term, language, target_term` (extra columns ignored).
 *    `language` is either a locale code or `ALL` (applies to every language).
 *    An optional `case_sensitive` column (yes/true) is honored.
 *  - Structured JSON: `{ doNotTranslate: [...], terms: [...] }` — see below.
 *
 * Confidence policy: a term with a blank target for a language is skipped, never
 * auto-filled. `translate`-strategy terms only apply to languages that have an
 * explicit target; `keep-english` / `doNotTranslate` apply to every language
 * (target = source) unless a language provides its own override.
 */

import { readFile } from "fs/promises";
import type { GlossaryTerm } from "../api/types.js";

/** `"ALL"` in a row's language field means "every target language". */
const ALL = "ALL";

interface GlossaryRow {
  source: string;
  language: string; // locale code or "ALL"
  target: string; // may be "" → skipped
  caseSensitive?: boolean;
}

export interface Glossary {
  rows: GlossaryRow[];
}

// ---- Structured JSON shape (loosely typed; extra fields ignored) ----
interface JsonDoNotTranslate {
  term: string;
  aliases?: string[];
}
interface JsonTerm {
  source: string;
  strategy?: string; // "keep-english" | "translate" | ...
  targets?: Record<string, string>;
}
interface JsonGlossary {
  doNotTranslate?: JsonDoNotTranslate[];
  terms?: JsonTerm[];
}

/** Parse one CSV line into fields, honoring double-quoted fields with commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Split CSV content into records, respecting quoted fields that span newlines. */
function splitCsvRecords(content: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        // Escaped quote inside a quoted field — keep both, stay in quotes.
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      if (current.trim().length) records.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length) records.push(current);
  return records;
}

function truthy(v: string | undefined): boolean {
  return v != null && ["yes", "true", "1", "y"].includes(v.trim().toLowerCase());
}

function parseCsv(content: string): Glossary {
  const records = splitCsvRecords(content);
  if (!records.length) return { rows: [] };
  const header = parseCsvLine(records[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iSource = idx("source_term");
  const iLang = idx("language");
  const iTarget = idx("target_term");
  const iCase = idx("case_sensitive");
  if (iSource < 0 || iLang < 0 || iTarget < 0) {
    throw new Error(
      "Glossary CSV must have columns: source_term, language, target_term (found: " + header.join(", ") + ")"
    );
  }

  const rows: GlossaryRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const cells = parseCsvLine(records[r]);
    const source = cells[iSource]?.trim();
    if (!source) continue;
    rows.push({
      source,
      language: cells[iLang]?.trim() || ALL,
      target: cells[iTarget]?.trim() ?? "",
      caseSensitive: iCase >= 0 ? truthy(cells[iCase]) : undefined,
    });
  }
  return { rows };
}

function parseJson(content: string): Glossary {
  const data = JSON.parse(content) as JsonGlossary;
  const rows: GlossaryRow[] = [];

  // Do-not-translate: keep the term (and any aliases) verbatim in every language.
  // Case-sensitive so each casing variant maps to itself ("keep exact casing") and
  // aliases like OPINDEX / Opindex don't collide.
  for (const dnt of data.doNotTranslate ?? []) {
    const terms = [dnt.term, ...(dnt.aliases ?? [])];
    for (const t of terms) {
      if (t?.trim()) rows.push({ source: t.trim(), language: ALL, target: t.trim(), caseSensitive: true });
    }
  }

  // Terms: explicit per-language targets always apply. keep-english additionally
  // keeps the source verbatim for every other language; translate does not (an
  // unverified language gets no term — confidence policy).
  for (const term of data.terms ?? []) {
    const source = term.source?.trim();
    if (!source) continue;
    if (term.strategy === "keep-english") {
      rows.push({ source, language: ALL, target: source });
    }
    for (const [lang, target] of Object.entries(term.targets ?? {})) {
      if (target?.trim()) rows.push({ source, language: lang, target: target.trim() });
    }
  }

  return { rows };
}

/** Load a glossary file, detecting CSV vs JSON by extension then by content. */
export async function loadGlossary(path: string): Promise<Glossary> {
  const content = await readFile(path, "utf-8");
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return parseJson(content);
  if (lower.endsWith(".csv")) return parseCsv(content);
  // Fallback: sniff.
  return content.trimStart().startsWith("{") ? parseJson(content) : parseCsv(content);
}

/**
 * The glossary terms that apply to `targetLang`: rows scoped to that language or
 * to ALL, with an exact-language target overriding an ALL (keep) row for the same
 * source. Blank targets are dropped.
 */
export function glossaryTermsForLanguage(glossary: Glossary, targetLang: string): GlossaryTerm[] {
  const t = targetLang.toLowerCase();
  const applies = (lang: string) => lang === ALL || lang.toLowerCase() === t;

  // Sources that have an exact-language row → their ALL rows are overridden.
  // Keyed by exact source text so distinct casing variants (aliases) coexist.
  const exactSources = new Set(
    glossary.rows.filter((r) => r.language !== ALL && r.language.toLowerCase() === t).map((r) => r.source)
  );

  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];
  for (const row of glossary.rows) {
    if (!applies(row.language)) continue;
    if (!row.target) continue; // confidence policy: never auto-fill
    if (row.language === ALL && exactSources.has(row.source)) continue;
    if (seen.has(row.source)) continue; // dedup by exact source
    seen.add(row.source);
    out.push({
      source_text: row.source,
      target_text: row.target,
      ...(row.caseSensitive ? { case_sensitive: true } : {}),
    });
  }
  return out;
}
