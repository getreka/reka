# Onboarding Report: myapp -> RAG Infrastructure

## Project Details

| Field        | Value                                                |
| ------------ | ---------------------------------------------------- |
| Project Name | `myapp`                                              |
| Project Path | `/home/ake/myapp`                                    |
| RAG API URL  | `http://localhost:3100`                              |
| MCP Server   | `/home/ake/shared-ai-infra/mcp-server/dist/index.js` |
| Date         | 2026-02-26                                           |

## Infrastructure Health Check

| Service           | Status  | Details                                                    |
| ----------------- | ------- | ---------------------------------------------------------- |
| RAG API (:3100)   | RUNNING | Responding, 105 files indexed for current project          |
| Qdrant (:6333)    | RUNNING | 50 collections across 6 projects                           |
| Redis (:6380)     | RUNNING | 165 keys, 3.84M memory used                                |
| BGE-M3 (:8080)    | RUNNING | Embedding service operational (1024d vectors)              |
| MCP Server (dist) | BUILT   | `mcp-server/dist/index.js` exists with all 18 tool modules |

## Onboarding Steps

### Step 1: Create `.mcp.json` in project root

**Status: MANUAL ACTION REQUIRED**

The directory `/home/ake/myapp` does not exist. Once the project directory is created, add the following `.mcp.json` file at `/home/ake/myapp/.mcp.json`:

```json
{
  "mcpServers": {
    "rag": {
      "command": "node",
      "args": ["/home/ake/shared-ai-infra/mcp-server/dist/index.js"],
      "env": {
        "PROJECT_NAME": "myapp",
        "PROJECT_PATH": "/home/ake/myapp",
        "RAG_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

### Step 2: Create `CLAUDE.md` in project root

**Status: MANUAL ACTION REQUIRED**

Add a `CLAUDE.md` file at `/home/ake/myapp/CLAUDE.md` with RAG integration instructions. Recommended content:

```markdown
# myapp

## RAG MCP Tools

This project has a RAG MCP server connected for persistent memory, codebase search, and architectural knowledge.

### Before ANY code change:

1. `recall` - check prior context
2. `hybrid_search` or `search_codebase` - find existing implementations
3. `get_patterns` - check architectural patterns
4. `get_adrs` - check architectural decisions

### After completing work:

- `remember` - save important context
- `record_adr` - document architectural decisions
- `record_pattern` - document new patterns

### Tool Priority:

1. Glob/Read - known file paths
2. Grep - exact string matching
3. hybrid_search - best general search (keyword + semantic)
4. search_codebase - semantic search by concept
5. find_symbol - fast function/class/type lookup
6. search_graph - file dependencies
7. ask_codebase - synthesized answers
```

### Step 3: Index the codebase

**Status: ATTEMPTED - 0 files found (directory does not exist)**

Once the project has source code, run the indexing:

```
Use `index_codebase` tool (no parameters needed - indexes entire project)
```

This will create the following Qdrant collections:

- `myapp_codebase` - legacy unified index
- `myapp_code` - AST-parsed code with symbols/imports
- `myapp_config` - YAML/JSON config files
- `myapp_docs` - Markdown documentation
- `myapp_graph` - import/extends dependency edges
- `myapp_symbols` - fast symbol lookup (functions, classes, types)
- `myapp_sessions` - session metadata + context
- `myapp_agent_memory` - validated durable memories
- `myapp_memory_pending` - quarantined auto-memories
- `myapp_tool_usage` - MCP tool call tracking

### Step 4: Verify indexing

After indexing, verify with:

```
get_index_status  -> confirm completion
get_project_stats -> verify collection sizes
```

### Step 5: Record initial patterns and ADRs (optional)

Use `record_pattern` and `record_adr` to document:

- API endpoint structure
- Service/module organization
- Naming conventions
- Framework/library choices
- Database schema decisions
- Authentication approach

## Platform Context

### Existing Projects in RAG Infrastructure

| Project             | Collections | Vectors |
| ------------------- | ----------- | ------- |
| beep                | 11          | 104,043 |
| beep-app-engine     | 10          | 53,753  |
| Beep-SaaS-AppEngine | 10          | 53,935  |
| rag                 | 10          | 7,779   |
| shared-ai-infra     | 8           | 3,491   |
| Oranta-Expo         | 1           | 4       |

After onboarding, `myapp` will appear as a new project with its own isolated collections.

### Architecture Reference

```
Claude Code (myapp)
    |
    | stdio
    v
MCP Server (PROJECT_NAME=myapp)
    |
    | HTTP + X-Project-Name: myapp
    v
RAG API (:3100)
    |
    +---> Qdrant (:6333)  -- myapp_* collections
    +---> BGE-M3 (:8080)  -- 1024d embeddings
    +---> Redis  (:6380)  -- cache
    +---> Ollama (:11434) -- LLM (optional)
```

## Blockers

1. **Project directory does not exist**: `/home/ake/myapp` must be created with source code before indexing can proceed.
2. **`.mcp.json` cannot be created**: Requires the project directory to exist first.
3. **`CLAUDE.md` cannot be created**: Requires the project directory to exist first.

## Summary

| Step                          | Status                                      |
| ----------------------------- | ------------------------------------------- |
| Infrastructure health check   | PASSED - all services running               |
| MCP server build verification | PASSED - dist/index.js exists               |
| `.mcp.json` creation          | BLOCKED - directory does not exist          |
| `CLAUDE.md` creation          | BLOCKED - directory does not exist          |
| Codebase indexing             | BLOCKED - no source files to index          |
| Index verification            | BLOCKED - depends on indexing               |
| Pattern/ADR recording         | BLOCKED - depends on having code to analyze |

**Overall Status: PARTIALLY COMPLETE** - Infrastructure is ready and verified. Project directory `/home/ake/myapp` must be created before completing onboarding. All configuration templates and instructions are provided above.
