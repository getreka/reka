#!/usr/bin/env node
// Egress audit — backs the "no telemetry · self-hosted" claim.
//
// Two deterministic checks over the PRODUCT code (rag-api, mcp-server, cli):
//   1. No telemetry / analytics dependencies in any package.json.
//   2. Every hardcoded host in product source resolves to one of:
//        • local / self-hosted infra (localhost + the compose services), or
//        • an opt-in LLM provider a user explicitly enables with their own key
//          (OpenAI / Anthropic), or
//        • the project's own first-party domains (the hosted demo + site, only
//          reached in opt-in DEMO_MODE / --demo, or printed as help text).
//      ANY other host — a third-party telemetry / phone-home endpoint — fails.
//
// This is a static gate; it does not prove transitive-dependency runtime
// behavior. The dynamic firewall verification in docker/NO-EGRESS.md exercises
// the default Ollama-only stack with egress blocked end to end. Together they
// back the badge.
//
// Usage: node tools/egress-audit.mjs   (exit 0 = clean, 1 = violation)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_ROOTS = ['rag-api/src', 'mcp-server/src', 'cli/src'];
const PACKAGE_JSONS = ['rag-api/package.json', 'mcp-server/package.json', 'cli/package.json'];

const isScannable = (f) =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !f.includes('/__tests__/');

// Self-hosted infra: loopback + the docker-compose service names. A user runs
// all of these on their own machine; they are never third-party.
const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal',
  'qdrant', 'qdrant-cr', 'ollama', 'redis', 'redis-cr', 'jaeger', 'prometheus',
  'dashboard', 'rag-api', 'rag-api-cr',
]);

// Opt-in LLM providers — reached ONLY when the user supplies a key / sets the
// provider. Extend deliberately, in a PR, with a rationale.
const ALLOWED_PROVIDERS = new Set(['api.openai.com', 'api.anthropic.com']);

// The project's OWN first-party domains: the hosted demo, dashboard, and
// marketing site. Reached only in opt-in DEMO_MODE / --demo, or printed as
// help text — never a third-party data sink. A self-hoster (DEMO_MODE off)
// never contacts these.
const ALLOWED_FIRSTPARTY = new Set([
  'getreka.dev', 'app.getreka.dev', 'api.getreka.dev',
  'rag.akeryuu.com', 'demo.akeryuu.com', 'cdl.akeryuu.com',
]);

// Identifier / spec hosts that are never fetched.
const SPEC_HOSTS = /(^|\.)(w3\.org|json-schema\.org|modelcontextprotocol\.io|spdx\.org|example\.com)$/;

const TELEMETRY_DENYLIST = [
  'segment', 'analytics-node', '@segment/',
  'mixpanel', 'posthog', 'amplitude', '@amplitude/',
  '@sentry/', 'bugsnag', '@bugsnag/', 'rollbar', 'airbrake',
  'datadog', 'dd-trace', 'newrelic', 'elastic-apm',
  'google-analytics', 'fullstory', 'logrocket', 'heap-api',
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (isScannable(p)) out.push(p);
  }
  return out;
}

// A URL on a comment line is documentation, not egress.
const isCommentLine = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

const violations = [];
const seen = { providers: new Set(), firstparty: new Set(), local: new Set() };

// ── Check 1: no telemetry deps ──────────────────────────────────────────────
for (const pj of PACKAGE_JSONS) {
  const path = join(ROOT, pj);
  if (!existsSync(path)) continue;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    if (TELEMETRY_DENYLIST.some((bad) => dep.toLowerCase().includes(bad))) {
      violations.push(`TELEMETRY DEPENDENCY: "${dep}" in ${pj}`);
    }
  }
}

// ── Check 2: host allowlist over product source ─────────────────────────────
const URL_RE = /https?:\/\/([a-zA-Z0-9.-]+)/g;
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1].toLowerCase();
        if (LOCAL_HOSTS.has(host)) { seen.local.add(host); continue; }
        if (ALLOWED_PROVIDERS.has(host)) { seen.providers.add(host); continue; }
        if (ALLOWED_FIRSTPARTY.has(host)) { seen.firstparty.add(host); continue; }
        if (SPEC_HOSTS.test(host)) continue;
        violations.push(`UNAPPROVED THIRD-PARTY HOST: ${host} — ${file.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('Egress audit — "no telemetry · self-hosted"');
console.log(`  scanned: ${SCAN_ROOTS.join(', ')} (product .ts, excl. tests & comments)`);
console.log(`  opt-in providers seen:  ${[...seen.providers].join(', ') || 'none'}`);
console.log(`  first-party demo/site:  ${[...seen.firstparty].join(', ') || 'none'}`);
console.log(`  local/self-hosted infra: ${[...seen.local].join(', ') || 'none'}`);

if (violations.length) {
  console.error(`\n✗ EGRESS AUDIT FAILED (${violations.length}):`);
  for (const v of violations) console.error('  • ' + v);
  console.error('\nA new third-party host or telemetry dep breaks "no telemetry · self-hosted".');
  console.error('If it is an intentional opt-in provider, add it to ALLOWED_PROVIDERS with a rationale.');
  process.exit(1);
}

console.log('\n✓ Egress audit clean — no telemetry deps; every host is local, an opt-in provider, or first-party.');
