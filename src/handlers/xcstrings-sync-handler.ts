/**
 * XCStrings Sync Handler
 *
 * Encapsulates xcstrings-specific sync logic for the sync_translations tool.
 * XCStrings files are unique because all languages are stored in a single file.
 */

import { readFile, writeFile } from "fs/promises";
import type { LocaleFile } from "../locale-detection/index.js";
import type { KeyValue } from "../api/types.js";
import {
  parseXCStringsContent,
  updateXCStringsLocale,
  reconstructXCStringsContent,
  extractLocaleFromXCStrings,
  type XCStringsFile,
} from "../utils/xcstrings-parser.js";

/**
 * Parsed xcstrings source data for use in sync operations
 */
export interface XCStringsSourceData {
  file: LocaleFile;
  flatContent: KeyValue[];
  xcstringsData: XCStringsFile;
}

/**
 * Parse an xcstrings source file
 *
 * @param file LocaleFile metadata
 * @param content Raw file content
 * @returns Parsed data or null if invalid
 */
export function parseXCStringsSource(
  file: LocaleFile,
  content: string
): XCStringsSourceData | null {
  const parsed = parseXCStringsContent(content);
  if (!parsed) {
    return null;
  }

  return {
    file,
    flatContent: parsed.entries,
    xcstringsData: parsed.metadata,
  };
}

/**
 * Get the set of keys that exist in a target language within xcstrings
 *
 * @param xcstringsData Parsed xcstrings data
 * @param targetLang Target language code
 * @returns Set of keys that have non-empty translations
 */
export function getXCStringsExistingKeys(
  xcstringsData: XCStringsFile,
  targetLang: string
): Set<string> {
  const targetEntries = extractLocaleFromXCStrings(xcstringsData, targetLang);
  const existingKeys = new Set<string>();

  for (const entry of targetEntries) {
    if (entry.value && entry.value.trim() !== "") {
      existingKeys.add(entry.key);
    }
  }

  return existingKeys;
}

/**
 * Check if a target language has any missing keys compared to source
 *
 * @param xcstringsData Parsed xcstrings data
 * @param targetLang Target language code
 * @param sourceContent Source language content
 * @returns true if any source keys are missing in target
 */
export function xcstringsHasMissingKeys(
  xcstringsData: XCStringsFile,
  targetLang: string,
  sourceContent: KeyValue[]
): boolean {
  const existingTargetKeys = getXCStringsExistingKeys(xcstringsData, targetLang);

  return sourceContent.some((item) => !existingTargetKeys.has(item.key));
}

/**
 * Determine what content needs to be synced for xcstrings
 *
 * @param sourceData Parsed xcstrings source data
 * @param targetLang Target language code
 * @param cachedContent Cached content from previous sync (null if no cache)
 * @param deltaContent Content that changed since last sync
 * @param isMissingLang Whether the target language is completely missing
 * @param hasMissingKeys Whether target has any missing keys
 * @param skipKeys Set of keys to skip for this language
 * @returns Content to sync (after filtering skip keys)
 */
export function getXCStringsContentToSync(
  sourceData: XCStringsSourceData,
  targetLang: string,
  cachedContent: Record<string, string> | null,
  deltaContent: KeyValue[],
  isMissingLang: boolean,
  hasMissingKeys: boolean,
  skipKeys: Set<string>
): { contentToSync: KeyValue[]; skippedKeys: string[] } {
  let contentToSync: KeyValue[];

  if (isMissingLang) {
    // New language: sync all source content
    contentToSync = sourceData.flatContent;
  } else if (!cachedContent || hasMissingKeys) {
    // No cache OR target has missing translations: sync missing keys
    const existingTargetKeys = getXCStringsExistingKeys(
      sourceData.xcstringsData,
      targetLang
    );
    contentToSync = sourceData.flatContent.filter(
      (item) => !existingTargetKeys.has(item.key)
    );
  } else {
    // Has cache: use delta
    contentToSync = deltaContent;
  }

  // Apply skip_keys filter
  const skippedKeys: string[] = [];
  const filteredContent = contentToSync.filter((item) => {
    if (skipKeys.has(item.key)) {
      skippedKeys.push(item.key);
      return false;
    }
    return true;
  });

  return { contentToSync: filteredContent, skippedKeys };
}

/**
 * Write translations to an xcstrings file
 *
 * Reads the current file state, updates the target language, and writes back.
 * Returns the updated xcstrings data for subsequent language updates.
 *
 * @param filePath Path to the xcstrings file
 * @param currentData Current xcstrings data (may be stale if file was modified)
 * @param targetLang Target language code
 * @param translations Translations to write
 * @returns Updated xcstrings data
 */
export async function writeXCStringsTranslations(
  filePath: string,
  currentData: XCStringsFile,
  targetLang: string,
  translations: KeyValue[]
): Promise<XCStringsFile> {
  // Read current state of the file (may have been updated by previous language)
  let xcstringsData = currentData;
  try {
    const currentContent = await readFile(filePath, "utf-8");
    const parsed = parseXCStringsContent(currentContent);
    if (parsed) {
      xcstringsData = parsed.metadata;
    }
  } catch {
    // Use provided data if file can't be read
  }

  // Update the target language
  const updatedData = updateXCStringsLocale(xcstringsData, targetLang, translations);

  // Write back to file
  const fileContent = reconstructXCStringsContent(updatedData);
  await writeFile(filePath, fileContent, "utf-8");

  return updatedData;
}
