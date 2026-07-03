/**
 * Integration tests for the simplified sync_translations tool.
 *
 * Unlike the old client-side diff/merge tests, this exercises the actual
 * tool handler end-to-end: it reads the real fixture files, mocks only the
 * network boundary (POST /api/v1/translate-file), and asserts on what gets
 * written to disk — verifying the thin-client contract (read source +
 * previous translation, send both, write back whatever comes back).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { copyFixtureToTemp, type TempTestDir } from "../helpers/temp-directory.js";
import { readJsonFixture, readRawFixture, fileExists } from "../helpers/fixture-loader.js";
import { mockTranslateFileFetch } from "../mocks/api-client.mock.js";

vi.mock("../../src/config/env.js", () => ({
  API_BASE_URL: "https://mock.langapi.io",
  getApiKey: () => "mock-api-key",
  isApiKeyConfigured: () => true,
  getMaskedApiKey: () => "mock-***",
}));

vi.mock("../../src/utils/delay.js", () => ({
  delay: vi.fn(() => Promise.resolve()),
}));

type ToolHandler = (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

async function loadSyncTranslationsHandler(): Promise<ToolHandler> {
  const { registerSyncTranslations } = await import("../../src/tools/sync-translations.js");
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _shape: unknown, fn: ToolHandler) => {
      handler = fn;
    },
  } as unknown as McpServer;
  registerSyncTranslations(fakeServer);
  if (!handler) throw new Error("sync_translations tool was not registered");
  return handler;
}

function parseOutput(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("sync_translations (thin client)", () => {
  let tempDir: TempTestDir;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("json-nested");
    fetchMock = vi.fn(mockTranslateFileFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("dry_run does not write files and reports a cost summary", async () => {
    const handler = await loadSyncTranslationsHandler();

    const result = await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: true,
    });

    const output = parseOutput(result);
    expect(output.success).toBe(true);
    expect(output.dry_run).toBe(true);
    expect(output.summary.words_to_translate).toBeGreaterThan(0);

    // de.json already exists in the fixture but is missing some keys —
    // dry_run must not touch it.
    const targetBefore = await readJsonFixture(tempDir.path, "locales/de.json");
    expect((targetBefore.app as Record<string, unknown>).tagline).toBeUndefined();
  });

  it("sends the previous translation content when the target file already exists", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.source_lang).toBe("en");
    expect(body.target_lang).toBe("de");
    expect(body.file_format).toBe("json");
    expect(typeof body.previous_target_file_content).toBe("string");
  });

  it("omits previous_target_file_content for a brand new language", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.previous_target_file_content).toBeUndefined();

    const written = await fileExists(tempDir.path, "locales/fr.json");
    expect(written).toBe(true);
  });

  it("writes the server's translated_file_content verbatim for each target language", async () => {
    const handler = await loadSyncTranslationsHandler();
    const result = await handler({
      source_lang: "en",
      target_langs: ["de", "fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const output = parseOutput(result);
    expect(output.success).toBe(true);
    expect(output.dry_run).toBe(false);
    expect(output.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const de = await readJsonFixture(tempDir.path, "locales/de.json");
    expect((de.app as Record<string, unknown>).tagline).toBe("Build something amazing-de");

    const fr = await readJsonFixture(tempDir.path, "locales/fr.json");
    expect((fr.app as Record<string, unknown>).name).toBe("My Application-fr");
  });

  it("does not write to disk when write_to_files is false", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["fr"],
      project_path: tempDir.path,
      write_to_files: false,
      dry_run: false,
    });

    const written = await fileExists(tempDir.path, "locales/fr.json");
    expect(written).toBe(false);
  });

  it("returns an error when the source language is not found", async () => {
    const handler = await loadSyncTranslationsHandler();
    const result = await handler({
      source_lang: "ja",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: true,
    });

    const output = parseOutput(result);
    expect(output.success).toBe(false);
    expect(output.error.code).toBe("SOURCE_NOT_FOUND");
  });
});

describe("sync_translations (xcstrings — single file for all locales)", () => {
  let tempDir: TempTestDir;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("ios-xcstrings");
    fetchMock = vi.fn(mockTranslateFileFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads and writes the same physical file for the target locale", async () => {
    const original = await readRawFixture(tempDir.path, "Localizable.xcstrings");

    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.file_format).toBe("xcstrings");
    // xcstrings holds every language in one file, so the "previous target" is
    // the same physical file — seeded from the current on-disk content so the
    // server merges into it (rather than dropping earlier languages).
    expect(body.previous_target_file_content).toBe(original);

    const raw = await readRawFixture(tempDir.path, "Localizable.xcstrings");
    const parsed = JSON.parse(raw);
    const anyKey = Object.keys(parsed.strings)[0];
    expect(parsed.strings[anyKey].localizations.de).toBeDefined();
  });

  it("preserves earlier languages when syncing multiple locales into one file (#4)", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de", "fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    // The second language must merge into the file already containing the
    // first — before the fix, syncing "fr" after "de" overwrote the file with
    // a stale en-only snapshot and silently discarded the (already-billed) de.
    const raw = await readRawFixture(tempDir.path, "Localizable.xcstrings");
    const parsed = JSON.parse(raw);
    const anyKey = Object.keys(parsed.strings)[0];
    expect(parsed.strings[anyKey].localizations.de).toBeDefined();
    expect(parsed.strings[anyKey].localizations.fr).toBeDefined();

    // Every source key should carry both translated locales, not just the last.
    for (const key of Object.keys(parsed.strings)) {
      const locs = parsed.strings[key].localizations ?? {};
      if (locs.en) {
        expect(locs.de, `${key} missing de`).toBeDefined();
        expect(locs.fr, `${key} missing fr`).toBeDefined();
      }
    }
  });
});

describe("sync_translations (arb — Flutter .arb files)", () => {
  let tempDir: TempTestDir;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("flutter-arb");
    fetchMock = vi.fn(mockTranslateFileFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends file_format=arb and threads the existing translation forward", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.file_format).toBe("arb");
    // app_de.arb already exists, so its content is threaded as the previous target.
    expect(typeof body.previous_target_file_content).toBe("string");
  });

  it("writes the server's translated arb content to app_de.arb", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const de = await readJsonFixture(tempDir.path, "lib/l10n/app_de.arb");
    expect(de.appName).toBe("My Application-de");
    expect(de.authLogin).toBe("Log in-de");
    // Metadata keys (@-prefixed) are preserved, and @@locale is set to the target.
    expect(de["@@locale"]).toBe("de");
  });

  it("creates a brand new arb file for a language not yet present", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.previous_target_file_content).toBeUndefined();

    const written = await fileExists(tempDir.path, "lib/l10n/app_fr.arb");
    expect(written).toBe(true);
    const fr = await readJsonFixture(tempDir.path, "lib/l10n/app_fr.arb");
    expect(fr.appName).toBe("My Application-fr");
  });
});

describe("sync_translations (strings — iOS .strings files)", () => {
  let tempDir: TempTestDir;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("ios-strings");
    fetchMock = vi.fn(mockTranslateFileFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends file_format=strings and writes into the target .lproj directory", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.file_format).toBe("strings");

    const de = await readRawFixture(tempDir.path, "de.lproj/Localizable.strings");
    expect(de).toContain('"app.name" = "My Application-de";');
    expect(de).toContain('"auth.login" = "Log in-de";');
  });

  it("creates a new .lproj directory for a brand new language", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.previous_target_file_content).toBeUndefined();

    const written = await fileExists(tempDir.path, "fr.lproj/Localizable.strings");
    expect(written).toBe(true);
    const fr = await readRawFixture(tempDir.path, "fr.lproj/Localizable.strings");
    expect(fr).toContain('"app.name" = "My Application-fr";');
  });
});

describe("sync_translations (i18next — directory-per-locale JSON)", () => {
  let tempDir: TempTestDir;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await copyFixtureToTemp("i18next");
    fetchMock = vi.fn(mockTranslateFileFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await tempDir.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("translates every namespace file into the target locale directory as json", async () => {
    const handler = await loadSyncTranslationsHandler();
    const result = await handler({
      source_lang: "en",
      target_langs: ["de"],
      project_path: tempDir.path,
      dry_run: false,
    });

    const output = parseOutput(result);
    expect(output.success).toBe(true);

    // en/ has two namespaces (common.json + home.json) — both must be synced.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.file_format).toBe("json");
    }

    const common = await readJsonFixture(tempDir.path, "public/locales/de/common.json");
    expect(common.app_name).toBe("My Application-de");

    // home.json didn't exist for de yet — nested keys should be translated too.
    const home = await readJsonFixture(tempDir.path, "public/locales/de/home.json");
    expect(home.title).toBe("Welcome Home-de");
    expect((home.features as Record<string, unknown>).fast).toBe("Lightning Fast-de");
  });

  it("creates a full locale directory for a brand new language", async () => {
    const handler = await loadSyncTranslationsHandler();
    await handler({
      source_lang: "en",
      target_langs: ["fr"],
      project_path: tempDir.path,
      dry_run: false,
    });

    expect(await fileExists(tempDir.path, "public/locales/fr/common.json")).toBe(true);
    expect(await fileExists(tempDir.path, "public/locales/fr/home.json")).toBe(true);

    const common = await readJsonFixture(tempDir.path, "public/locales/fr/common.json");
    expect(common.greeting).toBe("Welcome, {{name}}!-fr");
  });
});
