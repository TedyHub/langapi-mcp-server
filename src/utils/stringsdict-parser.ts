/**
 * Stringsdict (.stringsdict) file parser
 *
 * Stringsdict files are XML plist files used for pluralization and
 * gender rules in iOS/macOS applications.
 *
 * Structure:
 * <dict>
 *   <key>items_count</key>
 *   <dict>
 *     <key>NSStringLocalizedFormatKey</key>
 *     <string>%#@count@</string>
 *     <key>count</key>
 *     <dict>
 *       <key>NSStringFormatSpecTypeKey</key>
 *       <string>NSStringPluralRuleType</string>
 *       <key>one</key>
 *       <string>%d item</string>
 *       <key>other</key>
 *       <string>%d items</string>
 *     </dict>
 *   </dict>
 * </dict>
 */

import type { KeyValue } from "../api/types.js";

/**
 * Plural variant types supported by iOS
 */
export type PluralVariant = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * All possible plural variants
 */
export const PLURAL_VARIANTS: PluralVariant[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
];

/**
 * Plural rule definition for a single variable
 */
export interface PluralRule {
  /** The format spec type (usually NSStringPluralRuleType) */
  specTypeKey: string;
  /** Optional format value type */
  formatValueTypeKey?: string;
  /** Plural variant values: zero, one, two, few, many, other */
  variants: Partial<Record<PluralVariant, string>>;
}

/**
 * A single stringsdict entry with its plural rules
 */
export interface StringsDictEntry {
  /** The key name (e.g., "items_count") */
  key: string;
  /** The NSStringLocalizedFormatKey value (e.g., "%#@count@") */
  formatKey: string;
  /** Plural rules keyed by variable name (e.g., "count") */
  pluralRules: Record<string, PluralRule>;
}

/**
 * Parsed content from a .stringsdict file
 */
export interface StringsDictContent {
  /** Parsed entries */
  entries: StringsDictEntry[];
}

/**
 * Parse a .stringsdict file content
 *
 * @param content Raw XML content
 * @returns Parsed content or null if invalid
 */
export function parseStringsDictContent(
  content: string
): StringsDictContent | null {
  try {
    const entries: StringsDictEntry[] = [];

    // Parse XML plist structure - find the root dict
    const plistMatch = content.match(/<plist[^>]*>([\s\S]*)<\/plist>/i);
    if (!plistMatch) {
      return null;
    }

    const plistContent = plistMatch[1];

    // Find the root dict content using balanced matching
    const rootDictContent = extractDictContent(plistContent);
    if (!rootDictContent) {
      return null;
    }

    // Parse root level key-dict pairs
    const rootPairs = parseRootDictPairs(rootDictContent);

    for (const [entryKey, entryContent] of rootPairs) {
      const entry = parseEntryDict(entryKey, entryContent);
      if (entry) {
        entries.push(entry);
      }
    }

    return { entries };
  } catch {
    return null;
  }
}

/**
 * Extract content between <dict> and </dict> tags, handling nesting
 */
function extractDictContent(content: string): string | null {
  const startMatch = content.match(/<dict>/i);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const start = startMatch.index + 6; // length of "<dict>"
  let depth = 1;
  let pos = start;

  while (pos < content.length && depth > 0) {
    const nextOpen = content.indexOf("<dict>", pos);
    const nextClose = content.indexOf("</dict>", pos);

    if (nextClose === -1) {
      return null; // Unbalanced
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 6;
    } else {
      depth--;
      if (depth === 0) {
        return content.slice(start, nextClose);
      }
      pos = nextClose + 7;
    }
  }

  return null;
}

/**
 * Parse root-level key-dict pairs from dict content
 */
function parseRootDictPairs(content: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let pos = 0;

  while (pos < content.length) {
    // Find next <key>
    const keyMatch = content.slice(pos).match(/<key>([^<]+)<\/key>/i);
    if (!keyMatch || keyMatch.index === undefined) {
      break;
    }

    const keyName = decodeXmlEntities(keyMatch[1]);
    pos += keyMatch.index + keyMatch[0].length;

    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }

    // Check if next element is <dict>
    if (content.slice(pos, pos + 6).toLowerCase() === "<dict>") {
      // Find matching </dict>
      const dictStart = pos + 6;
      let depth = 1;
      let dictPos = dictStart;

      while (dictPos < content.length && depth > 0) {
        const nextOpen = content.indexOf("<dict>", dictPos);
        const nextClose = content.indexOf("</dict>", dictPos);

        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          dictPos = nextOpen + 6;
        } else {
          depth--;
          if (depth === 0) {
            const dictContent = content.slice(dictStart, nextClose);
            pairs.push([keyName, dictContent]);
            pos = nextClose + 7;
          } else {
            dictPos = nextClose + 7;
          }
        }
      }
    }
  }

  return pairs;
}

/**
 * Parse an entry dict content
 */
function parseEntryDict(
  key: string,
  content: string
): StringsDictEntry | null {
  const pluralRules: Record<string, PluralRule> = {};
  let formatKey = "";

  // Extract all key-value pairs from the dict
  const pairs = extractDictPairs(content);

  for (const [pairKey, pairValue] of pairs) {
    if (pairKey === "NSStringLocalizedFormatKey" && typeof pairValue === "string") {
      formatKey = pairValue;
    } else if (typeof pairValue === "object" && pairValue !== null) {
      // This is a plural rule dict
      const rule = parsePluralRuleDict(pairValue as Record<string, string>);
      if (rule) {
        pluralRules[pairKey] = rule;
      }
    }
  }

  if (!formatKey) {
    return null;
  }

  return { key, formatKey, pluralRules };
}

/**
 * Extract key-value pairs from a dict element
 */
function extractDictPairs(
  content: string
): Array<[string, string | Record<string, string>]> {
  const pairs: Array<[string, string | Record<string, string>]> = [];
  let pos = 0;

  while (pos < content.length) {
    // Find next <key>
    const keyMatch = content.slice(pos).match(/<key>([^<]+)<\/key>/i);
    if (!keyMatch || keyMatch.index === undefined) {
      break;
    }

    const pairKey = decodeXmlEntities(keyMatch[1]);
    pos += keyMatch.index + keyMatch[0].length;

    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }

    // Check what type of value follows
    if (content.slice(pos, pos + 8).toLowerCase() === "<string>") {
      // String value
      const stringMatch = content.slice(pos).match(/<string>([^<]*)<\/string>/i);
      if (stringMatch) {
        pairs.push([pairKey, decodeXmlEntities(stringMatch[1])]);
        pos += stringMatch[0].length;
      }
    } else if (content.slice(pos, pos + 6).toLowerCase() === "<dict>") {
      // Dict value - find matching </dict>
      const dictStart = pos + 6;
      let depth = 1;
      let dictPos = dictStart;

      while (dictPos < content.length && depth > 0) {
        const nextOpen = content.indexOf("<dict>", dictPos);
        const nextClose = content.indexOf("</dict>", dictPos);

        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          dictPos = nextOpen + 6;
        } else {
          depth--;
          if (depth === 0) {
            const nestedContent = content.slice(dictStart, nextClose);
            // Recursively parse nested dict
            const nestedPairs = extractDictPairs(nestedContent);
            const nestedDict: Record<string, string> = {};
            for (const [k, v] of nestedPairs) {
              if (typeof v === "string") {
                nestedDict[k] = v;
              }
            }
            pairs.push([pairKey, nestedDict]);
            pos = nextClose + 7;
          } else {
            dictPos = nextClose + 7;
          }
        }
      }
    } else {
      // Unknown element, skip ahead
      pos++;
    }
  }

  return pairs;
}

/**
 * Parse a plural rule dict
 */
function parsePluralRuleDict(
  dict: Record<string, string>
): PluralRule | null {
  const specTypeKey = dict["NSStringFormatSpecTypeKey"];
  if (!specTypeKey) {
    return null;
  }

  const variants: Partial<Record<PluralVariant, string>> = {};
  for (const variant of PLURAL_VARIANTS) {
    if (dict[variant]) {
      variants[variant] = dict[variant];
    }
  }

  return {
    specTypeKey,
    formatValueTypeKey: dict["NSStringFormatValueTypeKey"],
    variants,
  };
}

/**
 * Decode XML entities
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}
