/**
 * Localizable.strings file parser
 *
 * Handles Apple's traditional localization format:
 * - Key-value pairs: "key" = "value";
 * - Comments: block and line comments
 * - Escaped characters: quotes, newlines, tabs, backslashes, Unicode
 */

import type { KeyValue } from "../api/types.js";

/**
 * Parsed content from a .strings file
 */
export interface StringsContent {
  /** Key-value translation pairs */
  entries: KeyValue[];
  /** Comments associated with keys (key -> comment text) */
  comments: Map<string, string>;
  /** File-level header comment (at top of file) */
  headerComment: string | null;
}

/**
 * Parse a Localizable.strings file content
 *
 * Handles:
 * - Basic key-value pairs: "key" = "value";
 * - Block comments above entries for descriptions
 * - Escaped quotes and special characters
 * - Multi-line values
 *
 * @param content Raw file content
 * @returns Parsed content with entries, comments, and header
 */
export function parseStringsContent(content: string): StringsContent {
  const entries: KeyValue[] = [];
  const comments = new Map<string, string>();
  let headerComment: string | null = null;

  // Track current position
  let pos = 0;
  let pendingComment: string | null = null;
  let isFirstEntry = true;

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }

    if (pos >= content.length) break;

    // Check for block comment /* ... */
    if (content.slice(pos, pos + 2) === "/*") {
      const commentEnd = content.indexOf("*/", pos + 2);
      if (commentEnd === -1) {
        // Unterminated comment, skip to end
        break;
      }
      const commentText = content.slice(pos + 2, commentEnd).trim();
      pendingComment = commentText;
      pos = commentEnd + 2;
      continue;
    }

    // Check for line comment // ...
    if (content.slice(pos, pos + 2) === "//") {
      const lineEnd = content.indexOf("\n", pos);
      const commentText =
        lineEnd === -1
          ? content.slice(pos + 2).trim()
          : content.slice(pos + 2, lineEnd).trim();
      pendingComment = commentText;
      pos = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }

    // Check for quoted key
    if (content[pos] === '"') {
      const keyResult = parseQuotedString(content, pos);
      if (!keyResult) {
        // Malformed, skip character
        pos++;
        continue;
      }

      const key = keyResult.value;
      pos = keyResult.end;

      // Skip whitespace
      while (pos < content.length && /\s/.test(content[pos])) {
        pos++;
      }

      // Expect '='
      if (content[pos] !== "=") {
        // Malformed, continue
        continue;
      }
      pos++;

      // Skip whitespace
      while (pos < content.length && /\s/.test(content[pos])) {
        pos++;
      }

      // Expect quoted value
      if (content[pos] !== '"') {
        // Malformed, continue
        continue;
      }

      const valueResult = parseQuotedString(content, pos);
      if (!valueResult) {
        // Malformed, skip
        pos++;
        continue;
      }

      const value = valueResult.value;
      pos = valueResult.end;

      // Skip whitespace
      while (pos < content.length && /\s/.test(content[pos])) {
        pos++;
      }

      // Expect ';'
      if (content[pos] === ";") {
        pos++;
      }

      // Store entry
      entries.push({ key, value });

      // Handle comment
      if (pendingComment !== null) {
        if (isFirstEntry && entries.length === 1) {
          // Check if this looks like a file header comment (contains copyright, license, etc.)
          if (
            /copyright|license|generated|created by/i.test(pendingComment)
          ) {
            headerComment = pendingComment;
          } else {
            comments.set(key, pendingComment);
          }
        } else {
          comments.set(key, pendingComment);
        }
        pendingComment = null;
      }

      isFirstEntry = false;
    } else {
      // Skip unknown character
      pos++;
    }
  }

  // If there's a pending comment at the end with no entry, it might be a header
  if (pendingComment !== null && entries.length === 0) {
    headerComment = pendingComment;
  }

  return { entries, comments, headerComment };
}

/**
 * Parse a quoted string starting at the given position
 *
 * @returns Object with unescaped value and end position, or null if malformed
 */
function parseQuotedString(
  content: string,
  start: number
): { value: string; end: number } | null {
  if (content[start] !== '"') return null;

  let pos = start + 1;
  let value = "";

  while (pos < content.length) {
    const char = content[pos];

    if (char === '"') {
      // End of string
      return { value, end: pos + 1 };
    }

    if (char === "\\") {
      // Escape sequence
      pos++;
      if (pos >= content.length) break;

      const escaped = content[pos];
      switch (escaped) {
        case "n":
          value += "\n";
          break;
        case "t":
          value += "\t";
          break;
        case "r":
          value += "\r";
          break;
        case '"':
          value += '"';
          break;
        case "\\":
          value += "\\";
          break;
        case "U":
        case "u":
          // Unicode escape: \U0000 or \u0000
          const hexLength = escaped === "U" ? 4 : 4;
          const hex = content.slice(pos + 1, pos + 1 + hexLength);
          if (/^[0-9A-Fa-f]+$/.test(hex)) {
            const codePoint = parseInt(hex, 16);
            value += String.fromCodePoint(codePoint);
            pos += hexLength;
          } else {
            // Invalid unicode, keep as-is
            value += "\\" + escaped;
          }
          break;
        default:
          // Unknown escape, keep both characters
          value += "\\" + escaped;
      }
      pos++;
    } else {
      value += char;
      pos++;
    }
  }

  // Unterminated string
  return null;
}

/**
 * Escape a string for use in a .strings file
 */
export function escapeStringsValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Reconstruct a .strings file from parsed content
 *
 * @param entries Translation key-value pairs
 * @param comments Comments to associate with keys
 * @param headerComment Optional file-level header comment
 * @returns Formatted .strings file content
 */
export function reconstructStringsContent(
  entries: KeyValue[],
  comments: Map<string, string>,
  headerComment: string | null
): string {
  const lines: string[] = [];

  // Add header comment if present
  if (headerComment) {
    lines.push(`/* ${headerComment} */`);
    lines.push("");
  }

  // Add each entry with its comment
  for (const { key, value } of entries) {
    const comment = comments.get(key);
    if (comment) {
      lines.push(`/* ${comment} */`);
    }
    lines.push(`"${escapeStringsValue(key)}" = "${escapeStringsValue(value)}";`);
  }

  // Ensure trailing newline
  return lines.join("\n") + "\n";
}

/**
 * Merge new translations into existing .strings content
 *
 * - Preserves existing translations not in newTranslations
 * - Updates with new translations
 * - Removes keys not in sourceKeys
 * - Preserves comments from source
 *
 * @param existingContent Existing target file content (raw string)
 * @param newTranslations New/updated translations from API
 * @param sourceComments Comments from source file
 * @param sourceKeys Set of all keys in source file
 * @returns Merged .strings file content
 */
export function mergeStringsContent(
  existingContent: string,
  newTranslations: KeyValue[],
  sourceComments: Map<string, string>,
  sourceKeys: Set<string>
): string {
  // Parse existing content
  const existing = parseStringsContent(existingContent);
  const existingMap = new Map<string, string>();
  for (const { key, value } of existing.entries) {
    existingMap.set(key, value);
  }

  // Create map of new translations
  const newMap = new Map<string, string>();
  for (const { key, value } of newTranslations) {
    newMap.set(key, value);
  }

  // Build merged entries - only include keys from source
  const mergedEntries: KeyValue[] = [];
  for (const key of sourceKeys) {
    // Prefer new translation, then existing, skip if neither
    const value = newMap.get(key) ?? existingMap.get(key);
    if (value !== undefined) {
      mergedEntries.push({ key, value });
    }
  }

  // Use source comments, preserve existing header
  return reconstructStringsContent(
    mergedEntries,
    sourceComments,
    existing.headerComment
  );
}
