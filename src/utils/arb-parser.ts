/**
 * ARB (Application Resource Bundle) parsing utilities
 *
 * ARB files are JSON-based localization files used by Flutter.
 * They contain:
 * - @@locale: the locale identifier (e.g., "en", "de")
 * - Regular keys: translatable strings (e.g., "greeting": "Hello")
 * - Metadata keys: start with @ (e.g., "@greeting": { description: "..." })
 *
 * Metadata should be preserved but NOT translated.
 */

import type { KeyValue } from "../api/types.js";

/**
 * Check if a file is an ARB file based on extension (case-insensitive)
 */
export function isArbFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".arb");
}

/**
 * Get the file extension for locale files (.json or .arb)
 */
export function getLocaleFileExtension(filePath: string): string {
  if (isArbFile(filePath)) return ".arb";
  return ".json";
}

/**
 * Check if a key is ARB metadata (starts with @)
 */
export function isArbMetadataKey(key: string): boolean {
  return key.startsWith("@");
}

/**
 * Check if a key is the ARB locale identifier (@@locale)
 */
export function isArbLocaleKey(key: string): boolean {
  return key === "@@locale";
}

/**
 * Parsed ARB content with translatable strings separated from metadata
 */
export interface ArbContent {
  /** Locale identifier from @@locale, if present */
  locale: string | null;
  /** Keys to translate (non-@ prefixed string values) */
  translatableKeys: KeyValue[];
  /** Metadata entries (@ prefixed keys with their full values preserved) */
  metadata: Record<string, unknown>;
}

/**
 * Separate ARB content into translatable strings and metadata
 *
 * @param obj - Parsed ARB JSON object
 * @returns ArbContent with separated translatable keys and preserved metadata
 */
export function parseArbContent(obj: Record<string, unknown>): ArbContent {
  const translatableKeys: KeyValue[] = [];
  const metadata: Record<string, unknown> = {};
  let locale: string | null = null;

  for (const [key, value] of Object.entries(obj)) {
    if (key === "@@locale") {
      // Extract locale identifier
      locale = String(value);
      metadata[key] = value; // Also preserve in metadata for reconstruction
    } else if (key.startsWith("@")) {
      // Metadata key - preserve as-is (including nested objects)
      metadata[key] = value;
    } else {
      // Translatable key - must be a string
      if (typeof value === "string") {
        translatableKeys.push({ key, value });
      }
      // Skip non-string values (shouldn't happen in valid ARB files)
    }
  }

  return { locale, translatableKeys, metadata };
}

/**
 * Reconstruct ARB file content from translations and preserved metadata
 *
 * The output maintains ARB conventions:
 * - @@locale is set to the target locale
 * - Each translatable key is followed by its @metadata if it exists
 *
 * @param translations - Translated key-value pairs
 * @param metadata - Original metadata from source ARB file
 * @param targetLocale - Target language code
 * @returns Reconstructed ARB object ready to be serialized
 */
export function reconstructArbContent(
  translations: KeyValue[],
  metadata: Record<string, unknown>,
  targetLocale: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Add @@locale first (update to target locale)
  result["@@locale"] = targetLocale;

  // Interleave translations with their metadata
  for (const { key, value } of translations) {
    result[key] = value;
    // Add corresponding metadata if it exists
    const metaKey = `@${key}`;
    if (metaKey in metadata) {
      result[metaKey] = metadata[metaKey];
    }
  }

  return result;
}

/**
 * Merge new translations into existing ARB content (incremental update)
 *
 * This function supports partial syncs by:
 * - Preserving existing translations that weren't updated
 * - Overriding with new translations from API
 * - Using source metadata for all keys (source is authoritative for metadata)
 * - Removing keys that no longer exist in source
 *
 * @param existingContent - Existing target ARB file content (parsed JSON)
 * @param newTranslations - New/updated translations from API
 * @param sourceMetadata - Metadata from source ARB file (authoritative)
 * @param sourceKeys - Set of all keys in source file (to detect removed keys)
 * @param targetLocale - Target language code
 * @returns Merged ARB object ready to be serialized
 */
export function mergeArbContent(
  existingContent: Record<string, unknown>,
  newTranslations: KeyValue[],
  sourceMetadata: Record<string, unknown>,
  sourceKeys: Set<string>,
  targetLocale: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Add @@locale first (update to target locale)
  result["@@locale"] = targetLocale;

  // Parse existing content to get current translations
  const existingArb = parseArbContent(existingContent);
  const existingTranslationsMap = new Map<string, string>();
  for (const { key, value } of existingArb.translatableKeys) {
    existingTranslationsMap.set(key, value);
  }

  // Create map of new translations for quick lookup
  const newTranslationsMap = new Map<string, string>();
  for (const { key, value } of newTranslations) {
    newTranslationsMap.set(key, value);
  }

  // Process all source keys in order
  // This ensures we only include keys that exist in source (removes deleted keys)
  for (const key of sourceKeys) {
    // Use new translation if available, otherwise keep existing, otherwise skip
    const value = newTranslationsMap.get(key) ?? existingTranslationsMap.get(key);
    if (value !== undefined) {
      result[key] = value;
      // Add metadata from source (source metadata is authoritative)
      const metaKey = `@${key}`;
      if (metaKey in sourceMetadata) {
        result[metaKey] = sourceMetadata[metaKey];
      }
    }
  }

  return result;
}
