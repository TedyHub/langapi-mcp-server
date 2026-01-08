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

/**
 * Get all language codes present in an .xcstrings file
 *
 * @param xcstrings Parsed xcstrings data
 * @returns Set of language codes
 */
export function getXCStringsLanguages(xcstrings: XCStringsFile): Set<string> {
  const languages = new Set<string>();

  for (const entry of Object.values(xcstrings.strings)) {
    if (entry.localizations) {
      for (const lang of Object.keys(entry.localizations)) {
        languages.add(lang);
      }
    }
  }

  return languages;
}

/**
 * Update a specific locale's translations in an .xcstrings file
 *
 * This adds or updates translations for a single language without
 * affecting other languages in the file.
 *
 * @param xcstrings Original xcstrings data
 * @param locale Target language code
 * @param translations New translations for the locale
 * @returns Updated xcstrings data
 */
export function updateXCStringsLocale(
  xcstrings: XCStringsFile,
  locale: string,
  translations: KeyValue[]
): XCStringsFile {
  // Deep clone to avoid mutating original
  const result: XCStringsFile = JSON.parse(JSON.stringify(xcstrings));

  // Create a map for quick lookup
  const translationsMap = new Map<string, string>();
  for (const { key, value } of translations) {
    translationsMap.set(key, value);
  }

  // Update each string entry
  for (const [key, entry] of Object.entries(result.strings)) {
    const translation = translationsMap.get(key);
    if (translation !== undefined) {
      // Ensure localizations object exists
      if (!entry.localizations) {
        entry.localizations = {};
      }

      // Add or update the locale
      entry.localizations[locale] = {
        stringUnit: {
          state: "translated",
          value: translation,
        },
      };
    }
  }

  return result;
}

/**
 * Merge new translations into an .xcstrings file for a specific locale
 *
 * - Preserves existing translations for the locale that aren't updated
 * - Preserves all other languages completely
 * - Removes keys that no longer exist in source
 * - Updates state to "translated" for new translations
 *
 * @param existing Existing xcstrings data
 * @param locale Target language code
 * @param newTranslations New/updated translations
 * @param sourceKeys Set of all keys in source language
 * @returns Merged xcstrings data
 */
export function mergeXCStringsContent(
  existing: XCStringsFile,
  locale: string,
  newTranslations: KeyValue[],
  sourceKeys: Set<string>
): XCStringsFile {
  // Deep clone to avoid mutating original
  const result: XCStringsFile = JSON.parse(JSON.stringify(existing));

  // Create a map for quick lookup
  const newTranslationsMap = new Map<string, string>();
  for (const { key, value } of newTranslations) {
    newTranslationsMap.set(key, value);
  }

  // Remove keys that don't exist in source
  for (const key of Object.keys(result.strings)) {
    if (!sourceKeys.has(key)) {
      delete result.strings[key];
    }
  }

  // Update translations for the target locale
  for (const key of sourceKeys) {
    const entry = result.strings[key];
    if (!entry) continue;

    // Get new translation if available
    const newTranslation = newTranslationsMap.get(key);

    if (newTranslation !== undefined) {
      // Ensure localizations object exists
      if (!entry.localizations) {
        entry.localizations = {};
      }

      // Add or update the locale
      entry.localizations[locale] = {
        stringUnit: {
          state: "translated",
          value: newTranslation,
        },
      };
    }
    // If no new translation, preserve existing (already in the cloned data)
  }

  return result;
}

/**
 * Reconstruct .xcstrings JSON content with proper formatting
 *
 * @param xcstrings XCStrings data to serialize
 * @returns Formatted JSON string
 */
export function reconstructXCStringsContent(xcstrings: XCStringsFile): string {
  // Xcode uses 2-space indentation
  return JSON.stringify(xcstrings, null, 2) + "\n";
}

/**
 * Create a new empty .xcstrings structure
 *
 * @param sourceLanguage Source language code
 * @returns New empty xcstrings structure
 */
export function createEmptyXCStrings(sourceLanguage: string): XCStringsFile {
  return {
    sourceLanguage,
    version: "1.0",
    strings: {},
  };
}
