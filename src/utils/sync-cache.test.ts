import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectLocalDelta,
  getFullDiff,
  readSyncCache,
  writeSyncCache,
} from "./sync-cache.js";
import type { KeyValue } from "../api/types.js";

describe("detectLocalDelta", () => {
  it("should mark all keys as new when cache is null", () => {
    const currentContent: KeyValue[] = [
      { key: "hello", value: "Hello" },
      { key: "world", value: "World" },
    ];

    const result = detectLocalDelta(currentContent, null);

    expect(result.newKeys).toEqual(["hello", "world"]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual([]);
    expect(result.contentToSync).toEqual(currentContent);
  });

  it("should return empty arrays when current content is empty", () => {
    const cachedContent = { hello: "Hello", world: "World" };

    const result = detectLocalDelta([], cachedContent);

    expect(result.newKeys).toEqual([]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual([]);
    expect(result.contentToSync).toEqual([]);
  });

  it("should detect all new keys when none exist in cache", () => {
    const currentContent: KeyValue[] = [
      { key: "new1", value: "New 1" },
      { key: "new2", value: "New 2" },
    ];
    const cachedContent = { existing: "Existing" };

    const result = detectLocalDelta(currentContent, cachedContent);

    expect(result.newKeys).toEqual(["new1", "new2"]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual([]);
    expect(result.contentToSync).toHaveLength(2);
  });

  it("should detect all unchanged keys when values match", () => {
    const currentContent: KeyValue[] = [
      { key: "hello", value: "Hello" },
      { key: "world", value: "World" },
    ];
    const cachedContent = { hello: "Hello", world: "World" };

    const result = detectLocalDelta(currentContent, cachedContent);

    expect(result.newKeys).toEqual([]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual(["hello", "world"]);
    expect(result.contentToSync).toEqual([]);
  });

  it("should detect changed keys when values differ", () => {
    const currentContent: KeyValue[] = [
      { key: "hello", value: "Hello there" },
      { key: "world", value: "World" },
    ];
    const cachedContent = { hello: "Hello", world: "World" };

    const result = detectLocalDelta(currentContent, cachedContent);

    expect(result.newKeys).toEqual([]);
    expect(result.changedKeys).toEqual(["hello"]);
    expect(result.unchangedKeys).toEqual(["world"]);
    expect(result.contentToSync).toHaveLength(1);
    expect(result.contentToSync[0]).toEqual({ key: "hello", value: "Hello there" });
  });

  it("should handle mixed new, changed, and unchanged keys", () => {
    const currentContent: KeyValue[] = [
      { key: "new", value: "New key" },
      { key: "changed", value: "Changed value" },
      { key: "unchanged", value: "Same value" },
    ];
    const cachedContent = {
      changed: "Original value",
      unchanged: "Same value",
      removed: "This will be ignored by detectLocalDelta",
    };

    const result = detectLocalDelta(currentContent, cachedContent);

    expect(result.newKeys).toEqual(["new"]);
    expect(result.changedKeys).toEqual(["changed"]);
    expect(result.unchangedKeys).toEqual(["unchanged"]);
    expect(result.contentToSync).toHaveLength(2);
  });
});

describe("getFullDiff", () => {
  it("should mark all keys as new when cache is null", () => {
    const currentContent: KeyValue[] = [
      { key: "hello", value: "Hello" },
      { key: "world", value: "World" },
    ];

    const result = getFullDiff(currentContent, null);

    expect(result.newKeys).toEqual(["hello", "world"]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual([]);
    expect(result.removedKeys).toEqual([]);
  });

  it("should detect removed keys", () => {
    const currentContent: KeyValue[] = [
      { key: "remaining", value: "Still here" },
    ];
    const cachedContent = {
      remaining: "Still here",
      removed1: "Gone",
      removed2: "Also gone",
    };

    const result = getFullDiff(currentContent, cachedContent);

    expect(result.newKeys).toEqual([]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual(["remaining"]);
    expect(result.removedKeys).toEqual(["removed1", "removed2"]);
  });

  it("should include old and new values for changed keys", () => {
    const currentContent: KeyValue[] = [
      { key: "greeting", value: "Welcome" },
    ];
    const cachedContent = { greeting: "Hello there" };

    const result = getFullDiff(currentContent, cachedContent);

    expect(result.changedKeys).toHaveLength(1);
    expect(result.changedKeys[0]).toEqual({
      key: "greeting",
      oldValue: "Hello there",
      newValue: "Welcome",
    });
  });

  it("should handle mixed scenario with all change types", () => {
    const currentContent: KeyValue[] = [
      { key: "new", value: "Brand new" },
      { key: "changed", value: "Updated value" },
      { key: "unchanged", value: "Same" },
    ];
    const cachedContent = {
      changed: "Old value",
      unchanged: "Same",
      removed: "Will be detected as removed",
    };

    const result = getFullDiff(currentContent, cachedContent);

    expect(result.newKeys).toEqual(["new"]);
    expect(result.changedKeys).toEqual([
      { key: "changed", oldValue: "Old value", newValue: "Updated value" },
    ]);
    expect(result.unchangedKeys).toEqual(["unchanged"]);
    expect(result.removedKeys).toEqual(["removed"]);
  });

  it("should handle empty current content with cached content", () => {
    const cachedContent = { key1: "Value 1", key2: "Value 2" };

    const result = getFullDiff([], cachedContent);

    expect(result.newKeys).toEqual([]);
    expect(result.changedKeys).toEqual([]);
    expect(result.unchangedKeys).toEqual([]);
    expect(result.removedKeys).toEqual(["key1", "key2"]);
  });
});

describe("readSyncCache / writeSyncCache", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `sync-cache-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should write and read back same content", async () => {
    const content: KeyValue[] = [
      { key: "hello", value: "Hello" },
      { key: "world", value: "World" },
    ];

    await writeSyncCache(testDir, "en", content);
    const result = await readSyncCache(testDir, "en");

    expect(result).toEqual({
      hello: "Hello",
      world: "World",
    });
  });

  it("should return null when cache file does not exist", async () => {
    const result = await readSyncCache(testDir, "en");

    expect(result).toBeNull();
  });

  it("should return null when source language does not match", async () => {
    const content: KeyValue[] = [{ key: "hello", value: "Hello" }];

    await writeSyncCache(testDir, "en", content);
    const result = await readSyncCache(testDir, "de");

    expect(result).toBeNull();
  });

  it("should create cache directory if it does not exist", async () => {
    const nestedDir = join(testDir, "nested", "path");
    const content: KeyValue[] = [{ key: "test", value: "Test" }];

    await writeSyncCache(nestedDir, "en", content);

    const cacheFile = join(nestedDir, ".langapi", "sync-cache.json");
    const fileContent = await readFile(cacheFile, "utf-8");
    const cache = JSON.parse(fileContent);

    expect(cache.sourceLang).toBe("en");
    expect(cache.content).toEqual({ test: "Test" });
    expect(cache.lastSync).toBeDefined();
  });

  it("should overwrite existing cache on subsequent writes", async () => {
    const content1: KeyValue[] = [{ key: "old", value: "Old value" }];
    const content2: KeyValue[] = [{ key: "new", value: "New value" }];

    await writeSyncCache(testDir, "en", content1);
    await writeSyncCache(testDir, "en", content2);

    const result = await readSyncCache(testDir, "en");

    expect(result).toEqual({ new: "New value" });
  });
});
