# @langapi/mcp-server

MCP (Model Context Protocol) server for [LangAPI](https://langapi.io) - AI-powered translation management for i18n projects.

This package enables AI assistants like Claude, Cursor, and VS Code extensions to manage translations in your project programmatically.

## Quick Start

```bash
# 1. Sign in — shows a code to enter at langapi.io/device
npx @langapi/mcp-server login

# 2. Add to your AI tool (example for Claude Desktop on macOS):
# Edit ~/Library/Application Support/Claude/claude_desktop_config.json
# No credentials go in the config — `login` stores them for you.

# 3. Start chatting:
# "Scan my project for translations"
# "What keys are missing in German?"
# "Sync all translations"
```

## Authentication

Sign in once with a browser — there are no API keys to create or paste.

Run `npx @langapi/mcp-server login`. It prints a short code and a link to
[langapi.io/device](https://langapi.io/device) (and opens your browser). Sign in,
enter the code, and approve — the CLI then stores a session token at
`~/.langapi/credentials.json` and refreshes it automatically. Run
`npx @langapi/mcp-server logout` to revoke it.

Because sign-in happens in your browser, an interactive terminal is required —
there is no non-interactive/CI credential.

## Features

- **Locale Detection**: Automatically detect i18n framework (next-intl, i18next, react-intl, iOS/macOS) and locale files
- **Translation Status**: Compare source and target locales to find missing translations
- **Sync Translations**: Translate missing keys via LangAPI with credit-based billing
- **Dry Run Mode**: Preview changes and costs before syncing (enabled by default)
- **Format Preservation**: Maintains JSON formatting when writing translated files
- **Server-Side Delta Detection**: The LangAPI backend compares each file against its previous translation and only translates what's new or changed, saving up to 90% on costs — this client never inspects file content itself
- **Apple Localization**: Support for iOS/macOS `.strings`, `.xcstrings`, and `.stringsdict` files
- **Glossary**: Keep brand names and domain terms consistent by pointing `sync_translations` at a project glossary file (`glossary_file`)
- **Account Status**: Check your plan, monthly word allowance / words remaining, and credit balance from your assistant (`get_account_status`)

## Installation

```bash
npm install @langapi/mcp-server
```

Or use directly with npx (recommended):

```bash
npx @langapi/mcp-server
```

---

## Setup by Tool

### Claude Desktop

**Config file locations:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

**Configuration:**

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

After editing, **restart Claude Desktop** for changes to take effect.

---

### Claude Code (CLI)

**Option 1: CLI command** (quickest)

```bash
# Add to current project (stored in .mcp.json)
claude mcp add langapi -- npx -y @langapi/mcp-server
```

**Option 2: Project-level config** (recommended for teams)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

**Option 3: User-level config**

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```


**Verify connection:**

```bash
# List configured servers
claude mcp list

# Check server status inside Claude Code
/mcp
```

**Remove server:**

```bash
claude mcp remove langapi
```

---

### Cursor

**Config file locations:**
- **Project-level**: `.cursor/mcp.json` in your project root
- **Global**: `~/.cursor/mcp.json`

**Configuration:**

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

**Alternative: Via UI**
1. Open Cursor Settings (Cmd/Ctrl + ,)
2. Search for "MCP"
3. Click "Edit in settings.json"
4. Add the configuration above

---

### VS Code with Cline

1. Install the [Cline extension](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)
2. Create `.vscode/cline_mcp_settings.json` in your project:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

3. Reload VS Code window (Cmd/Ctrl + Shift + P > "Reload Window")

---

### VS Code with Roo Code

1. Install the [Roo Code extension](https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline)
2. Create `.vscode/mcp.json` in your project:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

3. Reload VS Code window

---

### Windsurf

**Config file**: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"]
    }
  }
}
```

Restart Windsurf after editing.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGAPI_API_URL` | No | Custom API URL (default: `https://api.langapi.io`) |

---

## MCP Tools

### `list_local_locales`

Scan your project for locale JSON files and detect the i18n framework.

**Input:**
```json
{
  "project_path": "/path/to/project",  // optional, defaults to cwd
  "include_key_count": true            // optional, default: true
}
```

**Output:**
```json
{
  "framework": "next-intl",
  "confidence": "high",
  "source_lang": "en",
  "locales_path": "messages",
  "locales": [
    {
      "lang": "en",
      "files": [{ "path": "messages/en.json", "namespace": null, "key_count": 150 }],
      "total_keys": 150
    },
    {
      "lang": "de",
      "files": [{ "path": "messages/de.json", "namespace": null, "key_count": 120 }],
      "total_keys": 120
    }
  ],
  "config_file": "i18n.ts"
}
```

### `get_translation_status`

Compare source locale against targets to identify missing keys and estimate costs.

**Input:**
```json
{
  "source_lang": "en",
  "target_langs": ["de", "fr"],        // optional, all non-source by default
  "project_path": "/path/to/project"   // optional
}
```

**Output:**
```json
{
  "source_lang": "en",
  "source_keys": 150,
  "targets": [
    {
      "lang": "de",
      "status": "outdated",
      "keys": { "total": 120, "missing": ["new.key1", "new.key2"], "extra": [] }
    }
  ],
  "cost_estimate": {
    "words_to_translate": 45,
    "credits_required": 90,
    "current_balance": 1000,
    "balance_after_sync": 910
  }
}
```

### `sync_translations`

Sync translations via the LangAPI API. **Default is dry_run=true for safety.**

As of v2, this tool is a thin client: for each source file and target language it reads the current source file and the existing translation (if any) and sends both, as-is, to `POST /api/v1/translate-file`. All comparison, format parsing, and merging happens server-side — the client never inspects file content to decide what changed.

**Input:**
```json
{
  "source_lang": "en",
  "target_langs": ["de", "fr"],
  "dry_run": true,                     // default: true (preview mode)
  "project_path": "/path/to/project",  // optional
  "write_to_files": true,              // optional, default: true
  "glossary_file": "src/i18n/glossary/glossary.csv" // optional (see Glossary below)
}
```

**Output (dry_run=true):**
```json
{
  "success": true,
  "dry_run": true,
  "summary": {
    "new_keys": 2,
    "changed_keys": 0,
    "removed_keys": 0,
    "reused_from_cache": 118,
    "words_to_translate": 45,
    "credits_required": 90,
    "current_balance": 1000,
    "balance_after_sync": 910
  },
  "per_language": [
    { "language": "de", "file": "messages/en.json", "new_keys": 1, "changed_keys": 0, "removed_keys": 0, "reused_from_cache": 59 },
    { "language": "fr", "file": "messages/en.json", "new_keys": 1, "changed_keys": 0, "removed_keys": 0, "reused_from_cache": 59 }
  ],
  "message": "Preview: 45 words to translate across 2 language(s), 90 credits required. Run with dry_run=false to execute."
}
```

**Output (dry_run=false):**
```json
{
  "success": true,
  "dry_run": false,
  "results": [
    { "language": "de", "file_written": "/path/to/project/messages/de.json", "new_keys": 1, "changed_keys": 0, "removed_keys": 0, "reused_from_cache": 59 },
    { "language": "fr", "file_written": "/path/to/project/messages/fr.json", "new_keys": 1, "changed_keys": 0, "removed_keys": 0, "reused_from_cache": 59 }
  ],
  "cost": {
    "credits_used": 90,
    "balance_after_sync": 1910
  },
  "message": "Sync complete across 2 language(s)."
}
```

### `get_account_status`

Check your plan, monthly word allowance and how much of it remains this period, plus your credit balance. Takes no input.

**Output:**
```json
{
  "success": true,
  "plan": "pro",
  "monthly_allowance": 50000,
  "words_used_this_month": 12480,
  "words_remaining": 37520,
  "period_reset_at": "2026-08-05T00:00:00.000Z",
  "credits": 910,
  "unlimited_plan": true,
  "subscription_expires_at": "2026-08-05T00:00:00.000Z"
}
```

---

## Glossary

Keep brand names and domain terms consistent across languages by pointing
`sync_translations` at a glossary file in your repo (`glossary_file`). The glossary
stays in your project (version-controlled); the relevant terms for each target
language are sent inline with that language's request and applied server-side —
nothing is stored on the server.

A term with a **blank target** for a language is skipped, never machine-filled, so
you can list a term for review before a native target is confirmed.

Two formats are auto-detected:

**CSV** — columns `source_term`, `language`, `target_term` (any other columns are
ignored; an optional `case_sensitive` column of `yes`/`true` is honored). Use `ALL`
in `language` for a term that applies to every target language:

```csv
source_term,language,target_term
PIN,ALL,PIN
Token,ALL,Token
Token,ru,токен
Quote,de,Kurs
```

**JSON** — a `doNotTranslate` list (kept verbatim, case-sensitive, in every language)
plus `terms` (per-language `targets`; `strategy: "keep-english"` also keeps the source
verbatim where no target is given):

```json
{
  "doNotTranslate": [{ "term": "OPINDEX", "aliases": ["Opindex"] }, { "term": "PIN" }],
  "terms": [
    { "source": "Token", "strategy": "keep-english", "targets": { "ru": "токен" } },
    { "source": "Quote", "strategy": "translate", "targets": { "de": "Kurs", "es": "cotización" } }
  ]
}
```

An exact-language target always overrides an all-languages "keep" for the same term
(so `Token` stays `Token` in German but becomes `токен` in Russian).

---

## Prompt Examples

### Scanning Your Project

```
"Scan my project for translations"
"What i18n framework am I using?"
"List all my locale files"
"How many translation keys do I have?"
"What languages are configured in my project?"
```

### Checking Translation Status

```
"What translations are missing?"
"Compare English to all other languages"
"How many keys need to be translated for French?"
"Which languages are out of sync?"
"Show me the missing keys for German"
"How much will it cost to sync all languages?"
```

### Preview Changes (Dry Run)

```
"Preview what would happen if I sync all languages"
"Do a dry run for French translations"
"Show me what keys will be translated"
"What's the cost estimate for syncing German?"
"Preview the sync without making changes"
```

### Syncing Translations

```
"Sync all missing translations"
"Translate to German and French"
"Update all locale files with missing keys"
"Sync translations and write to files"
"Execute the translation sync"
```

### Advanced Operations

```
"Are there any extra keys in German that aren't in English?"
"Skip the settings.* keys when syncing"
"Only sync the home.* and nav.* keys"
"Sync to Japanese but skip experimental features"
```

### Glossary & Account

```
"Sync German and French using the glossary at src/i18n/glossary/glossary.csv"
"Translate to Russian, keeping the terms in my glossary.json"
"How many credits do I have left?"
```

### Complete Workflow Example

```
You: List the translations in my project

Claude: [Calls list_local_locales]
I found a next-intl project with English (150 keys) and German (120 keys) translations.

You: What translations are missing for German?

Claude: [Calls get_translation_status]
German is missing 30 keys. The sync would cost 85 credits (you have 1000 credits).

You: Sync the German translations

Claude: [Calls sync_translations with dry_run=true]
Preview: 30 keys will be translated, costing 85 credits. Should I proceed?

You: Yes, go ahead

Claude: [Calls sync_translations with dry_run=false]
Done! 30 keys translated. German file updated at messages/de.json.
```

---

## Supported Frameworks

The server automatically detects these i18n frameworks:

| Framework | Locale Patterns | Config Files |
|-----------|-----------------|--------------|
| **next-intl** | `messages/*.json`, `locales/*.json` | `i18n.ts`, `next.config.js` |
| **i18next** | `public/locales/*/*.json`, `locales/*/*.json` | `i18next.config.js`, `i18n.js` |
| **react-intl** | `src/lang/*.json`, `lang/*.json` | `src/i18n.ts` |
| **iOS/macOS** | `.strings`, `.xcstrings`, `.stringsdict` | `Info.plist` |
| **generic** | Various common patterns | - |

---

## Troubleshooting

### "MCP server not found"
- Ensure `npx` is in your PATH
- Try running `npx @langapi/mcp-server` manually to test
- On Windows, you may need to use the full path to npx

### "Not authenticated" or "Unauthorized"
- Sign in again with `npx @langapi/mcp-server login`
- Sessions refresh automatically; logging out or revoking elsewhere requires a fresh login

### "No locale files found"
- Check that your locale files match supported patterns (see Frameworks above)
- Verify files are valid JSON
- Try specifying `project_path` explicitly

### "Permission denied" when writing files
- Check file/directory write permissions
- On macOS, ensure your terminal has disk access

### Server not connecting
1. Restart your IDE/tool completely (not just reload)
2. Check the config file syntax (valid JSON?)
3. Look for error messages in your tool's developer console

### Dry run works but execute fails
- Check your credit balance at langapi.io
- Verify network connectivity to api.langapi.io

---

## Advanced Configuration

### Custom API URL

For self-hosted or enterprise deployments:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_URL": "https://your-api-server.com"
      }
    }
  }
}
```

---

## Plans & Billing

- **1 word = 1 credit** (only new or changed strings are billed — unchanged text is reused for free)
- **Free:** **2,000 words/month**, resets monthly. No card required.
- **Starter:** one-time **$15 → 100,000 credits** that never expire (for a single project).
- **Pro:** **$24/month** including **50,000 words/month**, then **$2 per extra 10,000 words**.

Check your remaining allowance any time with `get_account_status`, and manage billing at [langapi.io/dashboard/billing](https://langapi.io/dashboard/billing). See full details on the [pricing page](https://langapi.io/pricing).

---

## License

MIT
