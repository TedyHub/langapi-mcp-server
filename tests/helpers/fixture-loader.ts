/**
 * Fixture loading and manipulation utilities for tests
 */

import { readFile, writeFile, mkdir, access, rm } from "fs/promises";
import { join, dirname } from "path";

export type FixtureContent = Record<string, unknown>;

/**
 * Read a JSON fixture file
 */
export async function readJsonFixture(
  tempPath: string,
  relativePath: string
): Promise<FixtureContent> {
  const content = await readFile(join(tempPath, relativePath), "utf-8");
  return JSON.parse(content);
}

/**
 * Write a JSON fixture file
 */
export async function writeJsonFixture(
  tempPath: string,
  relativePath: string,
  content: FixtureContent
): Promise<void> {
  const fullPath = join(tempPath, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(content, null, 2) + "\n", "utf-8");
}

/**
 * Read a raw file content
 */
export async function readRawFixture(
  tempPath: string,
  relativePath: string
): Promise<string> {
  return await readFile(join(tempPath, relativePath), "utf-8");
}

/**
 * Write a raw file content
 */
export async function writeRawFixture(
  tempPath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = join(tempPath, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * Check if a file exists
 */
export async function fileExists(
  tempPath: string,
  relativePath: string
): Promise<boolean> {
  try {
    await access(join(tempPath, relativePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file
 */
export async function deleteFile(
  tempPath: string,
  relativePath: string
): Promise<void> {
  await rm(join(tempPath, relativePath), { force: true });
}

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested value in an object using dot notation
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Delete a nested key from an object using dot notation
 */
export function deleteNestedKey(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== "object") return;
    current = current[parts[i]] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}

/**
 * Modify a source fixture to add/remove keys for delta testing
 */
export async function modifyJsonFixture(
  tempPath: string,
  relativePath: string,
  modifications: {
    addKeys?: Record<string, unknown>;
    removeKeys?: string[];
  }
): Promise<void> {
  const content = await readJsonFixture(tempPath, relativePath);

  // Add new keys (handles nested paths)
  if (modifications.addKeys) {
    for (const [key, value] of Object.entries(modifications.addKeys)) {
      if (key.includes(".")) {
        setNestedValue(content, key, value);
      } else {
        content[key] = value;
      }
    }
  }

  // Remove keys (handles nested paths)
  if (modifications.removeKeys) {
    for (const key of modifications.removeKeys) {
      if (key.includes(".")) {
        deleteNestedKey(content, key);
      } else {
        delete content[key];
      }
    }
  }

  await writeJsonFixture(tempPath, relativePath, content);
}
