# @langapi/mcp-server

MCP (Model Context Protocol) server for [LangAPI](https://langapi.io) - AI-powered translation management for i18n projects.

This package enables AI assistants like Claude, Cursor, and VS Code extensions to manage translations in your project programmatically.

## Quick Start

```bash
# 1. Get your API key at https://langapi.io (1,000 free credits)

# 2. Add to your AI tool (example for Claude Desktop on macOS):
# Edit ~/Library/Application Support/Claude/claude_desktop_config.json

# 3. Start chatting:
# "Scan my project for translations"
# "What keys are missing in German?"
# "Sync all translations"
```

## Features

- **Locale Detection**: Automatically detect i18n framework (next-intl, i18next, react-intl) and locale files
- **Translation Status**: Compare source and target locales to find missing translations
- **Sync Translations**: Translate missing keys via LangAPI with credit-based billing
- **Dry Run Mode**: Preview changes and costs before syncing (enabled by default)
- **Format Preservation**: Maintains JSON formatting when writing translated files
- **Delta Detection**: Only translate new/changed keys, saving up to 90% on costs

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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
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
claude mcp add --transport stdio langapi \
  --env LANGAPI_API_KEY=your-api-key-here \
  -- npx @langapi/mcp-server

# Or add globally for all projects (stored in ~/.claude.json)
claude mcp add --transport stdio langapi --scope user \
  --env LANGAPI_API_KEY=your-api-key-here \
  -- npx @langapi/mcp-server
```

**Option 2: Project-level config** (recommended for teams)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

**Option 4: Environment variable**

```bash
export LANGAPI_API_KEY="your-api-key-here"
```

Then the MCP server will pick it up automatically.

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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
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
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Restart Windsurf after editing.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LANGAPI_API_KEY` | Yes | Your LangAPI API key (get one at [langapi.io](https://langapi.io)) |
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
  "project_path": "/path/to/project",  // optional
  "app_id": "your-app-id"              // optional, for accurate cost estimate
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

**Input:**
```json
{
  "source_lang": "en",
  "target_langs": ["de", "fr"],
  "dry_run": true,                     // default: true (preview mode)
  "project_path": "/path/to/project",  // optional
  "write_to_files": true,              // optional, default: true
  "skip_keys": ["key.to.skip"]         // optional, keys to exclude
}
```

**Output (dry_run=true):**
```json
{
  "success": true,
  "dry_run": true,
  "delta": {
    "new_keys": ["new.key1", "new.key2"],
    "changed_keys": [],
    "total_keys_to_sync": 2
  },
  "cost": {
    "words_to_translate": 45,
    "credits_required": 90,
    "current_balance": 1000,
    "balance_after_sync": 910
  },
  "message": "Preview: 2 keys to sync, 90 credits required. Run with dry_run=false to execute."
}
```

**Output (dry_run=false):**
```json
{
  "success": true,
  "dry_run": false,
  "results": [
    { "language": "de", "translated_count": 2, "file_written": "messages/de.json" },
    { "language": "fr", "translated_count": 2, "file_written": "messages/fr.json" }
  ],
  "cost": {
    "credits_used": 90,
    "balance_after_sync": 1910
  },
  "message": "Sync complete. 4 keys translated across 2 languages. 90 credits used."
}
```

### `get_diff`

Compare current source locale against the last synced version.

**Input:**
```json
{
  "source_lang": "en",
  "project_path": "/path/to/project"   // optional
}
```

**Output:**
```json
{
  "has_changes": true,
  "summary": {
    "new_keys": 3,
    "changed_keys": 1,
    "removed_keys": 0,
    "unchanged_keys": 146
  },
  "diff": {
    "new": ["feature.title", "feature.description", "feature.cta"],
    "changed": ["home.welcome"],
    "removed": [],
    "unchanged": ["..."]
  }
}
```

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
"What changed since my last sync?"
"Show diff between current and last synced version"
"Are there any extra keys in German that aren't in English?"
"Skip the settings.* keys when syncing"
"Only sync the home.* and nav.* keys"
"Sync to Japanese but skip experimental features"
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
| **generic** | Various common patterns | - |

---

## Troubleshooting

### "MCP server not found"
- Ensure `npx` is in your PATH
- Try running `npx @langapi/mcp-server` manually to test
- On Windows, you may need to use the full path to npx

### "API key invalid" or "Unauthorized"
- Verify your API key at [langapi.io/dashboard](https://langapi.io/dashboard)
- Check for extra spaces or quotes in your config
- Ensure the key is set in the `env` section, not `args`

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

### Multiple Projects

Use project-level config files (`.mcp.json`, `.cursor/mcp.json`) with different API keys per project.

### Custom API URL

For self-hosted or enterprise deployments:

```json
{
  "mcpServers": {
    "langapi": {
      "command": "npx",
      "args": ["@langapi/mcp-server"],
      "env": {
        "LANGAPI_API_KEY": "your-api-key",
        "LANGAPI_API_URL": "https://your-api-server.com"
      }
    }
  }
}
```

---

## Credits & Billing

LangAPI uses a credit-based billing system:
- **1 credit = 1 word** to translate
- New users get **1,000 free credits**
- Top up with **100,000 credits for $15** (no subscription, no expiry)

Get your API key at [langapi.io](https://langapi.io).

---

## License

MIT
