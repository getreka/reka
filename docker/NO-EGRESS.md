# No telemetry · self-hosted — how it's proven

Reka's promise is custody: your code, transcripts, and memories stay on your
machine. Two complementary checks back the badge.

## 1. Static gate (enforced in CI)

[`tools/egress-audit.mjs`](../tools/egress-audit.mjs) runs on every push and
PR (workflow: **No telemetry**). It fails the build if the product code
(`rag-api`, `mcp-server`, `cli`) ever:

- adds a telemetry / analytics dependency (segment, mixpanel, posthog, sentry,
  datadog, …), or
- hardcodes any host that isn't local/self-hosted infra, an **opt-in** LLM
  provider you enable with your own key (OpenAI / Anthropic), or the project's
  own first-party demo/site domains.

Run it yourself: `node tools/egress-audit.mjs`.

This is a source-level gate. It does not, by itself, prove transitive
dependency behavior — that's what the dynamic check below is for.

## 2. Dynamic verification (manual, run before a launch)

The default stack is Ollama-only: `rag-api` talks to `ollama`, `qdrant`, and
`redis` — all on your machine. Nothing else is contacted unless you opt into a
cloud LLM provider with your own key.

### Quick observation (non-invasive)

While the stack is running and serving traffic, list `rag-api`'s live TCP peers:

```bash
docker exec reka-api sh -c 'cat /proc/net/tcp' \
  | awk 'NR>1{print $3}' | sort -u
```

Every remote should be a private/loopback address (the docker network —
`qdrant`/`ollama`/`redis` — and `127.0.0.1`). **No public IP should appear.**
Confirmed on the production stack 2026-06-15: only `172.x` (docker network) and
loopback; zero public egress.

### Firewall block (the strong proof)

Prove the default loop needs **no internet** at all:

```bash
# 0. Pre-pull the embedding model once (needs internet), then you can cut it off:
docker exec reka-ollama ollama pull qwen3-embedding:4b

# 1. Block the rag-api container's egress to the public internet, keeping the
#    docker network + loopback. (Allow RFC-1918 + loopback, drop the rest.)
PID=$(docker inspect -f '{{.State.Pid}}' reka-api)
sudo nsenter -t "$PID" -n iptables -A OUTPUT -o lo -j ACCEPT
sudo nsenter -t "$PID" -n iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
sudo nsenter -t "$PID" -n iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
sudo nsenter -t "$PID" -n iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
sudo nsenter -t "$PID" -n iptables -A OUTPUT -j REJECT

# 2. Run a full round-trip against http://localhost:3100 with your key:
#    index a file -> search -> remember -> recall. It all works with the
#    internet cut off, because the default loop never leaves your network.

# 3. Flush the rules when done:
sudo nsenter -t "$PID" -n iptables -F OUTPUT
```

If every step succeeds with egress blocked, the default Ollama-only loop is
provably self-contained. (The only time Reka contacts a third party is when you
explicitly set `EMBEDDING_PROVIDER=openai` / `LLM_PROVIDER=openai` or supply an
`ANTHROPIC_API_KEY` — your choice, your key, your data.)
