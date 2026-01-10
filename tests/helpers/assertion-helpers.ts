/**
 * Custom assertion helpers for translation tests
 */

import { expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { getNestedValue } from "./fixture-loader.js";
import { mockTranslate } from "../mocks/api-client.mock.js";

/**
 * Assert that a JSON file contains the expected mock translation
 * Mock translations follow the pattern: originalValue-targetLang
 */
export async function assertMockTranslation(
  tempPath: string,
  relativePath: string,
  key: string,
  targetLang: string,
  originalValue: string
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");
  const parsed = JSON.parse(content);

  const value = getNestedValue(parsed, key);
  const expectedValue = mockTranslate(originalValue, targetLang);

  expect(value).toBe(expectedValue);
}

/**
 * Assert that a key exists in a JSON file with a specific value
 */
export async function assertKeyValue(
  tempPath: string,
  relativePath: string,
  key: string,
  expectedValue: unknown
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");
  const parsed = JSON.parse(content);

  const value = getNestedValue(parsed, key);
  expect(value).toEqual(expectedValue);
}

/**
 * Assert that a key does NOT exist in a JSON file
 */
export async function assertKeyNotExists(
  tempPath: string,
  relativePath: string,
  key: string
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");
  const parsed = JSON.parse(content);

  const value = getNestedValue(parsed, key);
  expect(value).toBeUndefined();
}

/**
 * Assert that a file exists
 */
export async function assertFileExists(
  tempPath: string,
  relativePath: string
): Promise<void> {
  const fullPath = join(tempPath, relativePath);
  try {
    await readFile(fullPath);
  } catch (error) {
    throw new Error(`Expected file to exist: ${relativePath}`);
  }
}

/**
 * Assert that a file does NOT exist
 */
export async function assertFileNotExists(
  tempPath: string,
  relativePath: string
): Promise<void> {
  const fullPath = join(tempPath, relativePath);
  try {
    await readFile(fullPath);
    throw new Error(`Expected file to NOT exist: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Assert the structure of an xcstrings file
 */
export async function assertXCStringsTranslation(
  tempPath: string,
  relativePath: string,
  key: string,
  lang: string,
  expectedValue: string
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");
  const parsed = JSON.parse(content);

  const stringEntry = parsed.strings?.[key];
  expect(stringEntry).toBeDefined();

  const localization = stringEntry?.localizations?.[lang];
  expect(localization).toBeDefined();

  const value = localization?.stringUnit?.value;
  expect(value).toBe(expectedValue);
}

/**
 * Assert that a .strings file contains a key-value pair
 */
export async function assertStringsFileContains(
  tempPath: string,
  relativePath: string,
  key: string,
  expectedValue: string
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");

  // Match pattern: "key" = "value";
  const regex = new RegExp(`"${escapeRegex(key)}"\\s*=\\s*"([^"]*)";`);
  const match = content.match(regex);

  expect(match).toBeTruthy();
  expect(match![1]).toBe(expectedValue);
}

/**
 * Assert that a .strings file does NOT contain a key
 */
export async function assertStringsFileNotContains(
  tempPath: string,
  relativePath: string,
  key: string
): Promise<void> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");

  // Match pattern: "key" = "value";
  const regex = new RegExp(`"${escapeRegex(key)}"\\s*=\\s*"`);
  const match = content.match(regex);

  expect(match).toBeNull();
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
