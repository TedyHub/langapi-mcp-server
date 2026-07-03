/**
 * String Catalog (.xcstrings) file parser
 *
 * String Catalogs are JSON-based localization files introduced in Xcode 15.
 * Key characteristics:
 * - Single file contains ALL languages
 * - JSON structure with sourceLanguage, version, and strings
 * - Each string entry can have localizations for multiple languages
 * - Supports metadata like extractionState and comments
 */

import type { KeyValue } from "../api/types.js";

/**
 * String unit state - translation status
 */
export type StringUnitState = "translated" | "needs_review" | "new" | "stale";

/**
 * String unit - the actual translated value
 */
export interface StringUnit {
  state: StringUnitState;
  value: string;
}

/**
 * Localization entry for a specific language
 */
export interface XCLocalization {
  stringUnit?: StringUnit;
  /** Variations for plurals, device-specific strings, etc. */
  variations?: Record<string, unknown>;
}

/**
 * Entry for a single string key
 */
export interface XCStringEntry {
  /** Manual, migrated, stale, etc. */
  extractionState?: string;
  /** Developer comment/description */
  comment?: string;
  /** Localizations keyed by language code */
  localizations?: Record<string, XCLocalization>;
}

/**
 * Root structure of an .xcstrings file
 */
export interface XCStringsFile {
  sourceLanguage: string;
  version: string;
  strings: Record<string, XCStringEntry>;
}

/**
 * Parsed content from an .xcstrings file
 */
export interface XCStringsContent {
  /** Source language code */
  sourceLanguage: string;
  /** File format version */
  version: string;
  /** Translation entries for source language */
  entries: KeyValue[];
  /** All localizations by language */
  allLocalizations: Map<string, KeyValue[]>;
  /** Full parsed structure for preservation */
  metadata: XCStringsFile;
}

/**
 * Parse an .xcstrings file content
 *
 * @param content Raw JSON content
 * @returns Parsed content or null if invalid
 */
export function parseXCStringsContent(content: string): XCStringsContent | null {
  try {
    const data = JSON.parse(content) as XCStringsFile;

    if (!data.sourceLanguage || !data.strings) {
      return null;
    }

    const sourceLanguage = data.sourceLanguage;
    const version = data.version || "1.0";
    const entries: KeyValue[] = [];
    const allLocalizations = new Map<string, KeyValue[]>();

    // Extract all languages and their translations
    const languages = new Set<string>();

    for (const [key, entry] of Object.entries(data.strings)) {
      if (entry.localizations) {
        for (const lang of Object.keys(entry.localizations)) {
          languages.add(lang);
        }
      }
    }

    // Initialize language maps
    for (const lang of languages) {
      allLocalizations.set(lang, []);
    }

    // Extract translations for each key
    for (const [key, entry] of Object.entries(data.strings)) {
      const localizations = entry.localizations || {};

      // Get source language translation for entries
      const sourceLocalization = localizations[sourceLanguage];
      if (sourceLocalization?.stringUnit?.value) {
        entries.push({ key, value: sourceLocalization.stringUnit.value });
      }

      // Extract all localizations
      for (const [lang, localization] of Object.entries(localizations)) {
        if (localization.stringUnit?.value) {
          const langEntries = allLocalizations.get(lang) || [];
          langEntries.push({ key, value: localization.stringUnit.value });
          allLocalizations.set(lang, langEntries);
        }
      }
    }

    return {
      sourceLanguage,
      version,
      entries,
      allLocalizations,
      metadata: data,
    };
  } catch {
    return null;
  }
}

/**
 * Extract translations for a specific locale from an .xcstrings file
 *
 * @param xcstrings Parsed xcstrings data
 * @param locale Language code to extract
 * @returns Array of key-value pairs for the locale
 */
export function extractLocaleFromXCStrings(
  xcstrings: XCStringsFile,
  locale: string
): KeyValue[] {
  const entries: KeyValue[] = [];

  for (const [key, entry] of Object.entries(xcstrings.strings)) {
    const localization = entry.localizations?.[locale];
    if (localization?.stringUnit?.value) {
      entries.push({ key, value: localization.stringUnit.value });
    }
  }

  return entries;
}
