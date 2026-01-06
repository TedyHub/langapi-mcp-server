/**
 * Locale detection orchestrator
 * Detects i18n framework and locale files in a project
 */

import { glob } from "glob";
import { readFile } from "fs/promises";
import { join, basename, dirname, relative } from "path";
import { existsSync } from "fs";
import {
  FRAMEWORK_PATTERNS,
  isLikelyLanguageCode,
  type FrameworkPattern,
} from "./patterns.js";
import { countKeys, parseJsonSafe } from "../utils/json-parser.js";
import { getLocaleFileExtension } from "../utils/arb-parser.js";

export interface LocaleFile {
  /** Absolute path to the file */
  path: string;
  /** Relative path from project root */
  relativePath: string;
  /** Namespace if applicable (from directory name) */
  namespace: string | null;
  /** Number of translation keys */
  keyCount: number;
}

export interface DetectedLocale {
  /** Language code */
  lang: string;
  /** Files for this language */
  files: LocaleFile[];
  /** Total key count across all files */
  totalKeys: number;
}

export interface LocaleDetectionResult {
  /** Detected framework */
  framework: string;
  /** Confidence level */
  confidence: "high" | "medium" | "low";
  /** Path to locales directory (relative) */
  localesPath: string | null;
  /** Detected source language */
  sourceLang: string | null;
  /** All detected locales */
  locales: DetectedLocale[];
  /** Path to i18n config file if found */
  configFile: string | null;
}

/**
 * Detect i18n framework and locale files in a project
 */
export async function detectLocales(
  projectPath: string,
  includeKeyCount = true
): Promise<LocaleDetectionResult> {
  // Try to detect framework from config files
  const { framework, configFile, confidence } = await detectFramework(projectPath);

  // Get the pattern for this framework
  const pattern = FRAMEWORK_PATTERNS[framework] || FRAMEWORK_PATTERNS.generic;

  // Find locale files
  const localeFiles = await findLocaleFiles(projectPath, pattern);

  // Group by language
  const locales = await groupByLanguage(
    projectPath,
    localeFiles,
    includeKeyCount
  );

  // Determine locales path
  const localesPath = determineLocalesPath(localeFiles, projectPath);

  // Try to detect source language (usually 'en' if present, or first one)
  const sourceLang =
    locales.find((l) => l.lang === "en")?.lang || locales[0]?.lang || null;

  return {
    framework,
    confidence,
    localesPath,
    sourceLang,
    locales,
    configFile,
  };
}

/**
 * Detect the i18n framework from config files
 */
async function detectFramework(
  projectPath: string
): Promise<{ framework: string; configFile: string | null; confidence: "high" | "medium" | "low" }> {
  // Check frameworks in order of specificity
  for (const [frameworkName, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (frameworkName === "generic") continue;

    for (const configFile of pattern.configFiles) {
      const fullPath = join(projectPath, configFile);
      if (existsSync(fullPath)) {
        // Read file and check content pattern
        if (pattern.configPattern) {
          try {
            const content = await readFile(fullPath, "utf-8");
            if (pattern.configPattern.test(content)) {
              return {
                framework: frameworkName,
                configFile: configFile,
                confidence: "high",
              };
            }
          } catch {
            // Ignore read errors
          }
        } else {
          return {
            framework: frameworkName,
            configFile: configFile,
            confidence: "medium",
          };
        }
      }
    }
  }

  // Fall back to generic
  return { framework: "generic", configFile: null, confidence: "low" };
}

/**
 * Find locale files matching the framework patterns
 */
async function findLocaleFiles(
  projectPath: string,
  pattern: FrameworkPattern
): Promise<string[]> {
  const allFiles: string[] = [];

  for (const globPattern of pattern.localeGlobs) {
    try {
      const files = await glob(globPattern, {
        cwd: projectPath,
        absolute: true,
        nodir: true,
      });
      allFiles.push(...files);
    } catch {
      // Ignore glob errors
    }
  }

  // Deduplicate
  return [...new Set(allFiles)];
}

/**
 * Group locale files by language
 */
async function groupByLanguage(
  projectPath: string,
  files: string[],
  includeKeyCount: boolean
): Promise<DetectedLocale[]> {
  const languageMap = new Map<string, LocaleFile[]>();

  for (const filePath of files) {
    const lang = extractLanguageFromPath(filePath);
    if (!lang) continue;

    let keyCount = 0;
    if (includeKeyCount) {
      try {
        const content = await readFile(filePath, "utf-8");
        const parsed = parseJsonSafe(content);
        if (parsed) {
          keyCount = countKeys(parsed);
        }
      } catch {
        // Ignore read errors
      }
    }

    const relativePath = relative(projectPath, filePath);
    const dirName = basename(dirname(filePath));
    const namespace =
      dirName !== lang && !isLikelyLanguageCode(dirName) ? dirName : null;

    const localeFile: LocaleFile = {
      path: filePath,
      relativePath,
      namespace,
      keyCount,
    };

    if (!languageMap.has(lang)) {
      languageMap.set(lang, []);
    }
    languageMap.get(lang)!.push(localeFile);
  }

  // Convert to array and calculate totals
  return Array.from(languageMap.entries()).map(([lang, files]) => ({
    lang,
    files,
    totalKeys: files.reduce((sum, f) => sum + f.keyCount, 0),
  }));
}

/**
 * Extract language code from file path
 * Supports patterns like:
 * - /locales/en.json, /messages/en/common.json, /public/locales/en/translation.json
 * - /lib/l10n/app_en.arb (Flutter underscore pattern)
 */
function extractLanguageFromPath(filePath: string): string | null {
  const parts = filePath.split("/");
  const ext = getLocaleFileExtension(filePath);
  const fileName = basename(filePath, ext);

  // Check if filename is a language code (e.g., en.json, en.arb)
  if (isLikelyLanguageCode(fileName)) {
    return fileName;
  }

  // Check Flutter-style underscore pattern (e.g., app_en.arb, intl_de.arb)
  const underscoreMatch = fileName.match(/_([a-z]{2}(?:-[A-Z]{2})?)$/);
  if (underscoreMatch && isLikelyLanguageCode(underscoreMatch[1])) {
    return underscoreMatch[1];
  }

  // Check parent directories for language code
  for (let i = parts.length - 2; i >= 0; i--) {
    if (isLikelyLanguageCode(parts[i])) {
      return parts[i];
    }
  }

  return null;
}

/**
 * Determine the common locales directory path
 */
function determineLocalesPath(
  files: string[],
  projectPath: string
): string | null {
  if (files.length === 0) return null;

  // Find common parent directory
  const relativePaths = files.map((f) => relative(projectPath, f));
  if (relativePaths.length === 0) return null;

  // Get the first path's directory parts
  const firstDir = dirname(relativePaths[0]).split("/");

  // Find common prefix
  let commonParts = [...firstDir];
  for (const relPath of relativePaths) {
    const parts = dirname(relPath).split("/");
    const newCommon: string[] = [];
    for (let i = 0; i < Math.min(commonParts.length, parts.length); i++) {
      if (commonParts[i] === parts[i]) {
        newCommon.push(commonParts[i]);
      } else {
        break;
      }
    }
    commonParts = newCommon;
  }

  return commonParts.length > 0 ? commonParts.join("/") : null;
}
