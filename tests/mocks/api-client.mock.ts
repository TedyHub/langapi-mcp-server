/**
 * Mock LangAPI server behavior for testing the sync_translations tool.
 *
 * Returns predictable translations by appending "-{lang}" suffix
 * Example: "Hello" + "de" = "Hello-de"
 *
 * This mock re-implements a *simplified* version of the server-side
 * file-translate pipeline (see langapi-api's file-translate.ts) — good
 * enough to verify the MCP client's read/POST/write behavior without
 * pulling in the real backend.
 */

import { vi } from "vitest";
import type { TranslateFileRequest, TranslateFileResponse } from "../../src/api/types.js";

/**
 * Creates a mock translation by appending language suffix
 * Example: mockTranslate("Hello", "de") => "Hello-de"
 */
export function mockTranslate(value: string, targetLang: string): string {
  return `${value}-${targetLang}`;
}

function translateJsonLeaves(obj: unknown, targetLang: string, skipKey?: (key: string) => boolean): unknown {
  if (typeof obj === "string") return mockTranslate(obj, targetLang);
  if (Array.isArray(obj)) return obj.map((v) => translateJsonLeaves(v, targetLang, skipKey));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (skipKey?.(key)) {
        result[key] = value;
      } else {
        result[key] = translateJsonLeaves(value, targetLang, skipKey);
      }
    }
    return result;
  }
  return obj;
}

function countJsonLeafKeys(obj: unknown, skipKey?: (key: string) => boolean): string[] {
  const keys: string[] = [];
  function walk(o: unknown, prefix: string) {
    if (o !== null && typeof o === "object" && !Array.isArray(o)) {
      for (const [key, value] of Object.entries(o)) {
        if (skipKey?.(key)) continue;
        walk(value, prefix ? `${prefix}.${key}` : key);
      }
    } else {
      keys.push(prefix);
    }
  }
  walk(obj, "");
  return keys;
}

function translateJson(sourceContent: string, targetLang: string): { translated: string; newKeys: string[] } {
  const data = JSON.parse(sourceContent);
  const translated = translateJsonLeaves(data, targetLang);
  return { translated: JSON.stringify(translated, null, 2) + "\n", newKeys: countJsonLeafKeys(data) };
}

function translateArb(sourceContent: string, targetLang: string): { translated: string; newKeys: string[] } {
  const data = JSON.parse(sourceContent);
  const skipKey = (key: string) => key.startsWith("@");
  const translated = translateJsonLeaves(data, targetLang, skipKey) as Record<string, unknown>;
  translated["@@locale"] = targetLang;
  return { translated: JSON.stringify(translated, null, 2) + "\n", newKeys: countJsonLeafKeys(data, skipKey) };
}

function translateStrings(sourceContent: string, targetLang: string): { translated: string; newKeys: string[] } {
  const lines = sourceContent.split("\n");
  const keys: string[] = [];
  const translatedLines = lines.map((line) => {
    const match = line.match(/^"([^"]+)"\s*=\s*"([^"]*)";$/);
    if (!match) return line;
    keys.push(match[1]);
    return `"${match[1]}" = "${mockTranslate(match[2], targetLang)}";`;
  });
  return { translated: translatedLines.join("\n"), newKeys: keys };
}

type XCStringsEntry = { localizations?: Record<string, { stringUnit?: { state?: string; value: string } }> };
type XCStringsDoc = { sourceLanguage: string; strings: Record<string, XCStringsEntry> };

function translateXCStrings(request: TranslateFileRequest): { translated: string; newKeys: string[] } {
  // Mirror the real server: read the source strings from source_file_content,
  // but merge the new locale into previous_target_file_content when the client
  // threads it forward (so earlier languages in the same physical file survive).
  const source = JSON.parse(request.source_file_content) as XCStringsDoc;
  const base = (request.previous_target_file_content
    ? JSON.parse(request.previous_target_file_content)
    : JSON.parse(request.source_file_content)) as XCStringsDoc;
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(source.strings)) {
    const sourceValue = entry.localizations?.[source.sourceLanguage]?.stringUnit?.value;
    if (sourceValue === undefined) continue;
    keys.push(key);
    const baseEntry = (base.strings[key] ??= { localizations: {} });
    baseEntry.localizations = baseEntry.localizations || {};
    baseEntry.localizations[request.target_lang] = {
      stringUnit: { state: "translated", value: mockTranslate(sourceValue, request.target_lang) },
    };
  }
  return { translated: JSON.stringify(base, null, 2) + "\n", newKeys: keys };
}

function translateByFormat(request: TranslateFileRequest): { translated: string; newKeys: string[] } {
  switch (request.file_format) {
    case "arb":
      return translateArb(request.source_file_content, request.target_lang);
    case "strings":
      return translateStrings(request.source_file_content, request.target_lang);
    case "xcstrings":
      return translateXCStrings(request);
    default:
      return translateJson(request.source_file_content, request.target_lang);
  }
}

/**
 * Mock fetch handler for POST /api/v1/translate-file. Install with:
 *   vi.stubGlobal("fetch", vi.fn(mockTranslateFileFetch));
 */
export async function mockTranslateFileFetch(_url: string, init?: RequestInit): Promise<Response> {
  const request = JSON.parse(init?.body as string) as TranslateFileRequest;
  const { translated, newKeys } = translateByFormat(request);

  let body: TranslateFileResponse;
  if (request.dry_run) {
    body = {
      success: true,
      delta: { newKeys, changedKeys: [], removedKeys: [], reusedFromCacheCount: 0 },
      cost: {
        wordsToTranslate: newKeys.length,
        creditsRequired: newKeys.length * 10,
        currentBalance: 10000,
        balanceAfterSync: 10000 - newKeys.length * 10,
      },
    };
  } else {
    body = {
      success: true,
      translated_file_content: translated,
      delta: { newKeys, changedKeys: [], removedKeys: [], reusedFromCacheCount: 0 },
      cost: { creditsUsed: newKeys.length * 10, balanceAfterSync: 10000 - newKeys.length * 10 },
    };
  }

  return new Response(JSON.stringify(body), { status: 200 });
}

export function installMockFetch() {
  return vi.fn(mockTranslateFileFetch);
}
