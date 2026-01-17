/**
 * Framework-specific patterns for detecting i18n locale files
 */

export interface FrameworkPattern {
  /** Config files that identify this framework */
  configFiles: string[];
  /** Glob patterns for locale files */
  localeGlobs: string[];
  /** Regex pattern to identify framework in config content */
  configPattern?: RegExp;
}

export const FRAMEWORK_PATTERNS: Record<string, FrameworkPattern> = {
  "next-intl": {
    configFiles: [
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "i18n.ts",
      "i18n.js",
      "src/i18n.ts",
      "src/i18n.js",
    ],
    localeGlobs: [
      "messages/*.json",
      "messages/*/*.json",
      "locales/*.json",
      "locales/*/*.json",
      "src/messages/*.json",
      "src/locales/*.json",
    ],
    configPattern: /next-intl|createNextIntlPlugin|NextIntlClientProvider/,
  },
  i18next: {
    configFiles: [
      "i18n.js",
      "i18n.ts",
      "i18next.config.js",
      "i18next.config.ts",
      "next-i18next.config.js",
      "src/i18n/index.ts",
      "src/i18n/index.js",
    ],
    localeGlobs: [
      "public/locales/*/*.json",
      "locales/*/*.json",
      "src/locales/*/*.json",
      "src/i18n/locales/*.json",
      "src/i18n/locales/*/*.json",
      "translations/*/*.json",
    ],
    configPattern: /i18next|next-i18next|react-i18next/,
  },
  "react-intl": {
    configFiles: ["src/i18n/index.ts", "src/i18n/index.js", "src/i18n.ts"],
    localeGlobs: [
      "src/lang/*.json",
      "src/locales/*.json",
      "lang/*.json",
      "compiled-lang/*.json",
    ],
    configPattern: /react-intl|IntlProvider|formatMessage/,
  },
  flutter: {
    configFiles: ["pubspec.yaml", "l10n.yaml", "lib/l10n.dart"],
    localeGlobs: [
      "lib/l10n/*.arb",
      "l10n/*.arb",
      "assets/l10n/*.arb",
      "assets/translations/*.arb",
      "lib/src/l10n/*.arb",
    ],
    configPattern: /flutter_localizations|intl|flutter_gen/,
  },
  "ios-macos": {
    configFiles: [
      "*.xcodeproj/project.pbxproj",
      "*.xcworkspace/contents.xcworkspacedata",
      "Package.swift",
      "Info.plist",
    ],
    localeGlobs: [
      // .lproj directory structure
      "*.lproj/Localizable.strings",
      "*.lproj/Localizable.stringsdict",
      "*.lproj/*.strings",
      "*.lproj/*.stringsdict",
      // Nested in Resources or Sources
      "Resources/*.lproj/*.strings",
      "Resources/*.lproj/*.stringsdict",
      "**/Resources/*.lproj/*.strings",
      "**/Resources/*.lproj/*.stringsdict",
      "Sources/**/*.lproj/*.strings",
      // String Catalogs (single file with all languages)
      "*.xcstrings",
      "**/Localizable.xcstrings",
      "**/*.xcstrings",
    ],
    configPattern: /import\s+(UIKit|AppKit|SwiftUI|Foundation)|NSLocalizedString/,
  },
  generic: {
    configFiles: [],
    localeGlobs: [
      // Patterns for when projectPath IS the locales folder
      "*.json", // flat: en.json at root
      "*/*.json", // nested: en/common.json, en/home.json
      "*.arb", // Flutter flat at root
      "*/*.arb", // Flutter nested at root
      // Standard patterns
      "locales/*.json",
      "translations/*.json",
      "i18n/*.json",
      "lang/*.json",
      "messages/*.json",
      "src/locales/*.json",
      "src/translations/*.json",
      "src/i18n/*.json",
      "src/lang/*.json",
      "src/messages/*.json",
      "public/locales/*.json",
      // ARB files (Flutter)
      "lib/l10n/*.arb",
      "l10n/*.arb",
      "locales/*.arb",
      // iOS/macOS files
      "*.lproj/*.strings",
      "*.lproj/*.stringsdict",
      "*.xcstrings",
    ],
  },
};

/**
 * Common language codes
 */
export const COMMON_LANGUAGE_CODES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "ja",
  "ko",
  "zh",
  "ar",
  "hi",
  "tr",
  "sv",
  "da",
  "no",
  "fi",
  "cs",
  "hu",
  "ro",
  "bg",
  "uk",
  "he",
  "th",
  "vi",
  "id",
  "ms",
  "el",
  "sk",
  "hr",
  "sl",
  "lt",
  "lv",
  "et",
  // With regions
  "en-US",
  "en-GB",
  "en-AU",
  "pt-BR",
  "pt-PT",
  "zh-CN",
  "zh-TW",
  "es-ES",
  "es-MX",
  "fr-FR",
  "fr-CA",
  "de-DE",
  "de-AT",
  "de-CH",
];

/**
 * Check if a string looks like a language code
 */
export function isLikelyLanguageCode(str: string): boolean {
  // Check exact match first
  if (COMMON_LANGUAGE_CODES.includes(str)) {
    return true;
  }
  // Check pattern: 2 lowercase letters, optionally followed by - and more
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(str);
}
