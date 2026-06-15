# Clean-machine verification (LB-3)

A re-runnable proof that a **brand-new user can go from zero state to a working,
authenticated RAG** following only the documented first-run path. Run it before
any public launch, or after changing the auth / onboarding / key-minting surface.

It uses [`docker-compose.cleanroom.yml`](./docker-compose.cleanroom.yml): a fully
isolated stack (project `reka-cr`, fresh volumes, distinct container names and
host ports `3399`/`6399`) that **does not touch the production stack**. It reuses
the host's Ollama for embeddings.

## Why deny-by-default is the starting condition

Reka is deny-by-default — there is no `ALLOW_ANONYMOUS` in the production compose.
A new user therefore can't call anything until they have a key, and
`POST /api/keys` itself requires auth (`authMiddleware` runs **before**
`requireAdmin`, so even a container-loopback request returns `401`). The first key
is minted by the CLI via `docker exec … generateKey` + a container restart (keys
are read once at startup). This harness proves that cold-start path actually works
end to end — not just in unit tests that mock `docker exec`.

## Prerequisites

- Docker + Docker Compose v2.24+ (for `host-gateway`).
- The host's Ollama running with the embedding model: `ollama pull qwen3-embedding:4b`
  (override `OLLAMA_URL` in the compose file if yours is elsewhere).

## Run

```bash
cd docker

# 1. Bring up the isolated clean-room (builds rag-api from source; fresh volumes)
docker compose -p reka-cr -f docker-compose.cleanroom.yml up -d --build
until curl -sf http://127.0.0.1:3399/health >/dev/null; do sleep 2; done

# 2. Zero state — keystore must be absent
docker exec reka-api-cr sh -c 'cat /app/data/keys.json 2>/dev/null || echo "NO keys.json (zero state)"'

# 3. Deny-by-default — a new user with no key is locked out
curl -s -o /dev/null -w 'whoami no-key: %{http_code}\n'  http://127.0.0.1:3399/api/whoami      # expect 401
curl -s -o /dev/null -w 'keys   no-key: %{http_code}\n' -X POST http://127.0.0.1:3399/api/keys \
  -H 'Content-Type: application/json' -d '{"project":"x"}'                                     # expect 401

# 4. Run the PUBLISHED CLI init from a fresh project — the real first-run UX
mkdir -p /tmp/cleantest && cd /tmp/cleantest && git init -q
REKA_API_URL=http://localhost:3399 REKA_CONTAINER=reka-api-cr \
  npx -y @getreka/cli@latest init --project cleantest --path /tmp/cleantest </dev/null
# expect: "✓ API key minted via container ... restarted to load the key",
#         ".mcp.json — rag server written", "Index status: idle"

# 5. The minted key authenticates
KEY=$(node -e "process.stdout.write(require('/tmp/cleantest/.mcp.json').mcpServers.rag.env.REKA_API_KEY)")
curl -s http://127.0.0.1:3399/api/whoami -H "X-Api-Key: $KEY"     # expect {"projectName":"cleantest",...}

# 6. Tear down (removes the clean-room volumes; production is untouched)
cd "$OLDPWD" && docker compose -p reka-cr -f docker-compose.cleanroom.yml down -v
rm -rf /tmp/cleantest
```

## PASS criteria

- Step 2: no keystore (genuine zero state).
- Step 3: both calls `401` (deny-by-default holds).
- Step 4: key minted via the `generateKey` + restart **fallback** (the loopback
  `POST /api/keys` correctly fails, so the CLI falls back); `.mcp.json` written
  with **`REKA_API_KEY`** (not the legacy `RAG_API_KEY`) and `@getreka/mcp@latest`.
- Step 5: `whoami` returns `200` with the project — the minted key works.

## Limitation

Same host kernel / Docker daemon as the box you run it on — not a literal separate
VM. It catches every LB-3-class bug (auth, onboarding, key-minting, deny-by-default,
compose correctness, env-var naming). A separate VM would additionally catch only
host-kernel / daemon-specific issues, which are out of scope for LB-3.
