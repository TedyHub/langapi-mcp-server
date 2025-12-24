/**
 * Validation utilities for input sanitization
 */

import { z } from "zod";
import { resolve, relative, isAbsolute } from "path";

/**
 * RFC 5646 language code pattern
 * Matches: en, de, fr, pt-BR, zh-CN, etc.
 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/**
 * Zod schema for language code validation
 */
export const languageCodeSchema = z
  .string()
  .min(2)
  .max(6)
  .regex(LANGUAGE_CODE_PATTERN, {
    message:
      "Invalid language code. Expected format: 'en', 'de', 'pt-BR', etc.",
  });

/**
 * Zod schema for array of language codes
 */
export const languageCodesArraySchema = z
  .array(languageCodeSchema)
  .min(1, { message: "At least one target language is required" });

/**
 * Validate a language code
 */
export function isValidLanguageCode(code: string): boolean {
  return LANGUAGE_CODE_PATTERN.test(code);
}

/**
 * Validate that a path is within the project directory
 * Prevents path traversal attacks
 */
export function isPathWithinProject(
  filePath: string,
  projectPath: string
): boolean {
  const resolvedProject = resolve(projectPath);
  const resolvedFile = resolve(projectPath, filePath);

  // Check that resolved file path starts with project path
  return resolvedFile.startsWith(resolvedProject);
}

/**
 * Get a safe file path within the project directory
 * Returns null if path would escape project directory
 */
export function getSafeFilePath(
  relativePath: string,
  projectPath: string
): string | null {
  const resolvedProject = resolve(projectPath);
  const resolvedFile = resolve(projectPath, relativePath);

  // Check that resolved file path starts with project path
  if (!resolvedFile.startsWith(resolvedProject)) {
    return null;
  }

  return resolvedFile;
}

/**
 * Sanitize a language code by ensuring it matches the expected pattern
 * Returns the sanitized code or null if invalid
 */
export function sanitizeLanguageCode(code: string): string | null {
  const trimmed = code.trim();
  if (isValidLanguageCode(trimmed)) {
    return trimmed;
  }
  return null;
}
