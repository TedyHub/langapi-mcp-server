/**
 * Common utilities for iOS/macOS localization file handling
 *
 * Apple localization uses several file formats:
 * - Localizable.strings: Traditional key-value format ("key" = "value";)
 * - String Catalogs (.xcstrings): Modern JSON-based format (Xcode 15+)
 * - Localizable.stringsdict: XML plist for plurals/gender
 *
 * Files are typically organized in .lproj directories:
 * - en.lproj/Localizable.strings
 * - de.lproj/Localizable.strings
 */

export type AppleFileType = "strings" | "xcstrings" | "stringsdict";

/**
 * Check if a file is an Apple .strings file
 */
export function isStringsFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".strings");
}

/**
 * Check if a file is an Apple String Catalog (.xcstrings)
 */
export function isXCStringsFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".xcstrings");
}

/**
 * Check if a file is an Apple stringsdict file
 */
export function isStringsDictFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".stringsdict");
}

/**
 * Detect Apple file type from file path
 * @returns The file type or null if not an Apple localization file
 */
export function detectAppleFileType(filePath: string): AppleFileType | null {
  if (isStringsFile(filePath)) return "strings";
  if (isXCStringsFile(filePath)) return "xcstrings";
  if (isStringsDictFile(filePath)) return "stringsdict";
  return null;
}

/**
 * Check if a file path is any Apple localization file type
 */
export function isAppleLocalizationFile(filePath: string): boolean {
  return detectAppleFileType(filePath) !== null;
}

/**
 * Extract language code from .lproj directory path
 *
 * Apple organizes locale files in language-specific directories:
 * - en.lproj/Localizable.strings -> "en"
 * - pt-BR.lproj/Main.strings -> "pt-BR"
 * - Base.lproj/Main.strings -> null (Base is special, not a language)
 *
 * @param filePath Path containing .lproj directory
 * @returns Language code or null if not found or is Base.lproj
 */
export function extractLanguageFromLproj(filePath: string): string | null {
  // Match language code before .lproj
  // Supports: en.lproj, de.lproj, pt-BR.lproj, zh-Hans.lproj
  const match = filePath.match(/\/([a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?)\.lproj\//i);

  if (!match) {
    return null;
  }

  const lang = match[1];

  // Skip Base.lproj - it's a special case for base internationalization
  if (lang.toLowerCase() === "base") {
    return null;
  }

  return lang;
}

/**
 * Compute target file path for .lproj directory structure
 *
 * Replaces the source language directory with the target language:
 * - /Project/en.lproj/Localizable.strings -> /Project/de.lproj/Localizable.strings
 *
 * @param sourcePath Original file path with source language .lproj
 * @param sourceLang Source language code
 * @param targetLang Target language code
 * @returns Target file path or null if no .lproj pattern found
 */
export function computeAppleLprojTargetPath(
  sourcePath: string,
  sourceLang: string,
  targetLang: string
): string | null {
  // Create regex that matches the source language .lproj directory
  // Use case-insensitive matching for the language code
  const lprojPattern = new RegExp(
    `(/)${escapeRegExp(sourceLang)}\\.lproj(/)`,
    "i"
  );

  if (!lprojPattern.test(sourcePath)) {
    return null;
  }

  // Replace source language with target language in the .lproj directory name
  return sourcePath.replace(lprojPattern, `$1${targetLang}.lproj$2`);
}

/**
 * Get the file extension for Apple localization files
 */
export function getAppleFileExtension(filePath: string): string {
  const fileType = detectAppleFileType(filePath);
  switch (fileType) {
    case "strings":
      return ".strings";
    case "xcstrings":
      return ".xcstrings";
    case "stringsdict":
      return ".stringsdict";
    default:
      return "";
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
