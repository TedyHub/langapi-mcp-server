/**
 * ARB (Application Resource Bundle) file helpers.
 *
 * ARB files are JSON-based localization files used by Flutter. Since the pivot,
 * all ARB parsing/merging happens server-side (langapi-api's parsers) — the MCP
 * client only needs to recognize ARB files and pick the right extension. The
 * former parse/reconstruct/merge helpers were dead code and have been removed
 * (finding #19).
 */

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
