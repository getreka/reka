# Transcript: Onboard /home/ake/myapp to RAG Infrastructure

## Task

Connect project `/home/ake/myapp` to the shared RAG infrastructure at `/home/ake/shared-ai-infra`.

## Pre-conditions

- `/home/ake/myapp` does NOT exist on disk (confirmed via Glob)
- RAG API is running at `https://rag.akeryuu.com` (or `localhost:3100`)
- The shared-ai-infra project itself is already onboarded as project name `rag`

---

## Tool Calls and Results

### 1. Glob: Check if /home/ake/myapp exists

**Call:** `Glob(pattern="*", path="/home/ake/myapp")`
**Result:** `Directory does not exist: /home/ake/myapp`
**Conclusion:** The target project directory does not exist. We will document what needs to happen when it is created.

### 2. Read: CLAUDE.md (understand MCP config format)

**Call:** `Read(file_path="/home/ake/shared-ai-infra/CLAUDE.md")`
**Result:** Full project documentation including MCP Server Config section showing `.mcp.json` format:

```json
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["/path/to/shared-ai-infra/mcp-server/dist/index.js"],
      "env": {
        "PROJECT_NAME": "myproject",
        "PROJECT_PATH": "/path/to/myproject",
        "RAG_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

### 3. mcp**rag**search_codebase: Find setup_project implementation

**Call:** `search_codebase(query="setup_project onboard new project configuration", limit=5)`
**Result:** Found relevant files:

- `docs/rag-setup-prompt.md` (58.1%) - Setup guide
- `mcp-server/src/tools/suggestions.ts` (54.0%) - Contains `setup_project` tool
- `rag-api/src/services/project-profile.ts` (55.1%) - Project profile service

### 4. Grep: Find setup_project in MCP server

**Call:** `Grep(pattern="setup_project|setup-project", path="/home/ake/shared-ai-infra/mcp-server/src")`
**Result:** Found in:

- `mcp-server/src/tools/suggestions.ts`
- `mcp-server/src/annotations.ts`

### 5. Grep: Find setup_project in RAG API

**Call:** `Grep(pattern="setup_project|setup-project", path="/home/ake/shared-ai-infra/rag-api/src")`
**Result:** No files found (setup_project is MCP-server-side only)

### 6. Read: docs/rag-setup-prompt.md (full setup guide)

**Call:** `Read(file_path="/home/ake/shared-ai-infra/docs/rag-setup-prompt.md")`
**Result:** Complete first-time setup guide with 4 steps:

1. Index the codebase with `index_codebase`
2. Verify indexing with `get_index_status` and `get_project_stats`
3. Record initial architectural patterns with `record_pattern`
4. Record key architectural decisions with `record_adr`

### 7. Read: setup_project handler implementation

**Call:** `Read(file_path="/home/ake/shared-ai-infra/mcp-server/src/tools/suggestions.ts", offset=420, limit=150)`
**Result:** Full handler code showing setup_project creates:

1. `.mcp.json` with MCP server configuration
2. `CLAUDE.md` RAG Integration section
3. `.claude/settings.local.json` with permissions
4. Checks index status

### 8. mcp**rag**setup_project: Attempt to setup myapp

**Call:** `setup_project(projectPath="/home/ake/myapp", projectName="myapp")`
**Result:** `Error: ENOENT: no such file or directory, open '/home/ake/myapp/.mcp.json'`
**Conclusion:** Cannot create files because directory doesn't exist. This is expected.

### 9. mcp**rag**get_project_stats: Check current RAG state

**Call:** `get_project_stats()`
**Result:**

- Total Files: 105
- Vector Count: 1024
- Languages: typescript (788), python (7), yaml (4), markdown (223), dockerfile (2)
- Last Indexed: 2/19/2026

### 10. mcp**rag**list_aliases: Check Qdrant aliases

**Call:** `list_aliases()`
**Result:** No aliases configured.

### 11. mcp**rag**get_index_status: Check current index

**Call:** `get_index_status()`
**Result:** Status idle, 0 indexed files, 1024 vectors, never fully indexed.

### 12. Read: Existing .mcp.json (reference config)

**Call:** `Read(file_path="/home/ake/shared-ai-infra/.mcp.json")`
**Result:**

```json
{
  "mcpServers": {
    "rag": {
      "command": "npx",
      "args": ["-y", "@crowley/rag-mcp@latest"],
      "env": {
        "PROJECT_NAME": "rag",
        "PROJECT_PATH": "/home/ake/shared-ai-infra",
        "RAG_API_URL": "https://rag.akeryuu.com",
        "RAG_API_KEY": "e699194c-53b3-4c8a-8833-5b82083bfeb1"
      }
    }
  }
}
```

---

## Onboarding Plan for /home/ake/myapp

Since `/home/ake/myapp` does not exist yet, here is the complete plan for when the directory is created.

### Step 1: Create the project directory

```bash
mkdir -p /home/ake/myapp
cd /home/ake/myapp
# Initialize your project (git init, npm init, etc.)
```

### Step 2: Run setup_project MCP tool

Once the directory exists, call the MCP tool:

```
setup_project(
  projectPath: "/home/ake/myapp",
  projectName: "myapp"
)
```

This will automatically create:

#### 2a. `/home/ake/myapp/.mcp.json`

```json
{
  "mcpServers": {
    "myapp-rag": {
      "command": "npx",
      "args": ["-y", "@crowley/rag-mcp@latest"],
      "env": {
        "RAG_API_URL": "https://rag.akeryuu.com",
        "PROJECT_NAME": "myapp",
        "PROJECT_PATH": "/home/ake/myapp"
      }
    }
  }
}
```

#### 2b. `/home/ake/myapp/CLAUDE.md` (RAG Integration section appended)

```markdown
## RAG Integration

You MUST call `context_briefing` before making any code changes.
This single tool performs all RAG lookups in parallel (recall, search, patterns, ADRs, graph).

Example: `context_briefing(task: "describe your change", files: ["path/to/file.ts"])`

After completing significant changes:

- `remember` -- save important context for future sessions
- `record_adr` -- document architectural decisions
```

#### 2c. `/home/ake/myapp/.claude/settings.local.json`

```json
{
  "permissions": {
    "allow": ["mcp__myapp-rag__*"]
  }
}
```

### Step 3: Restart Claude Code

After creating the configuration files, restart Claude Code so it picks up the new MCP server from `.mcp.json`.

### Step 4: Index the codebase

```
index_codebase()
```

This will:

- Parse all source files in `/home/ake/myapp`
- Create Qdrant collections: `myapp_codebase`, `myapp_code`, `myapp_config`, `myapp_docs`, `myapp_graph`, `myapp_symbols`
- Generate embeddings via BGE-M3 (1024-dimensional vectors)
- Store chunked code with AST-parsed symbols and imports

### Step 5: Verify indexing

```
get_index_status()
get_project_stats()
```

### Step 6: Record initial patterns and ADRs (optional but recommended)

```
record_pattern(
  name: "API Endpoint",
  description: "How API endpoints are structured in myapp",
  structure: "..."
)

record_adr(
  title: "Framework choice",
  context: "Why we chose X framework",
  decision: "Use X because..."
)
```

### Qdrant Collections Created

The following namespaced collections will be created in Qdrant for project isolation:

| Collection             | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `myapp_codebase`       | Legacy unified index of source code            |
| `myapp_code`           | AST-parsed code with symbols/imports           |
| `myapp_config`         | YAML/JSON config files                         |
| `myapp_docs`           | Markdown documentation                         |
| `myapp_graph`          | Import/extends dependency edges                |
| `myapp_symbols`        | Fast symbol lookup (functions, classes, types) |
| `myapp_memory`         | Agent memory (decisions, insights, ADRs)       |
| `myapp_agent_memory`   | Validated durable memories                     |
| `myapp_memory_pending` | Quarantined auto-memories                      |
| `myapp_sessions`       | Session metadata + context                     |
| `myapp_tool_usage`     | MCP tool call tracking                         |

### Architecture

```
/home/ake/myapp (consumer project)
  .mcp.json          --> points to RAG MCP server
  CLAUDE.md           --> RAG integration instructions
  .claude/
    settings.local.json --> MCP permissions

        |
        | (MCP protocol)
        v

shared-ai-infra/mcp-server
  PROJECT_NAME=myapp
  PROJECT_PATH=/home/ake/myapp

        |
        | HTTP (X-Project-Name: myapp)
        v

shared-ai-infra/rag-api (:3100)
        |
   +----+----+--------+
   |         |        |
 Qdrant   BGE-M3   Ollama
 :6333    :8080    :11434
```

---

## Summary

| Step                          | Status               | Notes                                     |
| ----------------------------- | -------------------- | ----------------------------------------- |
| Check myapp exists            | Confirmed NOT exists | Expected per task description             |
| Read setup documentation      | Done                 | `docs/rag-setup-prompt.md`, `CLAUDE.md`   |
| Understand setup_project tool | Done                 | Full handler reviewed in `suggestions.ts` |
| Call setup_project            | Failed (ENOENT)      | Directory must exist first                |
| Review existing .mcp.json     | Done                 | Reference configuration captured          |
| Check RAG API state           | Done                 | Currently serving `rag` project           |
| Generate onboarding plan      | Done                 | Complete plan with all files documented   |

## Key Findings

1. The `setup_project` MCP tool automates 80% of onboarding (creates `.mcp.json`, `CLAUDE.md`, `.claude/settings.local.json`)
2. Project isolation is achieved via Qdrant collection namespacing (`myapp_*` prefix)
3. The MCP server name follows the pattern `{projectName}-rag` (e.g., `myapp-rag`)
4. The consumer project uses `npx -y @crowley/rag-mcp@latest` to run the MCP server (no local install needed)
5. After setup, `index_codebase` must be run to populate vector collections
