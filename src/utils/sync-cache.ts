/**
 * Sync cache utility for delta detection
 * Stores previous source content to detect new/changed keys
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { KeyValue } from "../api/types.js";

interface SyncCache {
  sourceLang: string;
  content: Record<string, string>; // key -> value map
  lastSync: string; // ISO timestamp
}

interface SyncDelta {
  newKeys: string[];
  changedKeys: string[];
  unchangedKeys: string[];
  contentToSync: KeyValue[];
}

export interface KeyChange {
  key: string;
  oldValue: string;
  newValue: string;
}

export interface FullDiff {
  newKeys: string[];
  changedKeys: KeyChange[];
  unchangedKeys: string[];
  removedKeys: string[];
}

const CACHE_DIR = ".langapi";
const CACHE_FILE = "sync-cache.json";

function getCachePath(projectPath: string): string {
  return join(projectPath, CACHE_DIR, CACHE_FILE);
}

/**
 * Read the sync cache for a project
 */
export async function readSyncCache(
  projectPath: string,
  sourceLang: string
): Promise<Record<string, string> | null> {
  const cachePath = getCachePath(projectPath);
  console.error(`[SYNC-CACHE] Reading cache from: ${cachePath}`);

  try {
    const content = await readFile(cachePath, "utf-8");
    const cache: SyncCache = JSON.parse(content);

    // Only return cache if source language matches
    if (cache.sourceLang === sourceLang) {
      console.error(`[SYNC-CACHE] Cache found with ${Object.keys(cache.content).length} keys`);
      return cache.content;
    }
    console.error(`[SYNC-CACHE] Cache lang mismatch: ${cache.sourceLang} vs ${sourceLang}`);
    return null;
  } catch (err) {
    // Cache doesn't exist or is invalid
    console.error(`[SYNC-CACHE] Cache not found or invalid: ${err}`);
    return null;
  }
}

/**
 * Write the sync cache after a successful sync
 */
export async function writeSyncCache(
  projectPath: string,
  sourceLang: string,
  content: KeyValue[]
): Promise<void> {
  const cachePath = getCachePath(projectPath);
  console.error(`[SYNC-CACHE] Writing cache to: ${cachePath}`);

  try {
    // Ensure cache directory exists
    await mkdir(dirname(cachePath), { recursive: true });
    console.error(`[SYNC-CACHE] Directory ensured: ${dirname(cachePath)}`);

    // Convert KeyValue array to map
    const contentMap: Record<string, string> = {};
    for (const item of content) {
      contentMap[item.key] = item.value;
    }

    const cache: SyncCache = {
      sourceLang,
      content: contentMap,
      lastSync: new Date().toISOString(),
    };

    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
    console.error(`[SYNC-CACHE] Cache written successfully with ${content.length} keys`);
  } catch (err) {
    console.error(`[SYNC-CACHE] Error writing cache: ${err}`);
    throw err;
  }
}

/**
 * Detect delta between current content and cached content
 */
export function detectLocalDelta(
  currentContent: KeyValue[],
  cachedContent: Record<string, string> | null
): SyncDelta {
  const newKeys: string[] = [];
  const changedKeys: string[] = [];
  const unchangedKeys: string[] = [];
  const contentToSync: KeyValue[] = [];

  // If no cache, all keys are new
  if (!cachedContent) {
    return {
      newKeys: currentContent.map((c) => c.key),
      changedKeys: [],
      unchangedKeys: [],
      contentToSync: currentContent,
    };
  }

  for (const item of currentContent) {
    const cachedValue = cachedContent[item.key];

    if (cachedValue === undefined) {
      // Key doesn't exist in cache - it's new
      newKeys.push(item.key);
      contentToSync.push(item);
    } else if (cachedValue !== item.value) {
      // Key exists but value changed
      changedKeys.push(item.key);
      contentToSync.push(item);
    } else {
      // Key exists and value is the same - unchanged
      unchangedKeys.push(item.key);
    }
  }

  return {
    newKeys,
    changedKeys,
    unchangedKeys,
    contentToSync,
  };
}

/**
 * Get full diff including removed keys
 */
export function getFullDiff(
  currentContent: KeyValue[],
  cachedContent: Record<string, string> | null
): FullDiff {
  const newKeys: string[] = [];
  const changedKeys: KeyChange[] = [];
  const unchangedKeys: string[] = [];
  const removedKeys: string[] = [];

  // If no cache, all keys are new
  if (!cachedContent) {
    return {
      newKeys: currentContent.map((c) => c.key),
      changedKeys: [],
      unchangedKeys: [],
      removedKeys: [],
    };
  }

  // Track which cached keys we've seen
  const seenCachedKeys = new Set<string>();

  for (const item of currentContent) {
    const cachedValue = cachedContent[item.key];
    seenCachedKeys.add(item.key);

    if (cachedValue === undefined) {
      newKeys.push(item.key);
    } else if (cachedValue !== item.value) {
      changedKeys.push({
        key: item.key,
        oldValue: cachedValue,
        newValue: item.value,
      });
    } else {
      unchangedKeys.push(item.key);
    }
  }

  // Find removed keys (in cache but not in current)
  for (const key of Object.keys(cachedContent)) {
    if (!seenCachedKeys.has(key)) {
      removedKeys.push(key);
    }
  }

  return {
    newKeys,
    changedKeys,
    unchangedKeys,
    removedKeys,
  };
}
