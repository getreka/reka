/**
 * Transcript Miner - rule-based memory-candidate extraction (v1) from Claude
 * Code session transcripts (JSONL, shipped by the reka-plugin SessionEnd hook
 * to POST /api/capture/transcript).
 *
 * Three rules, no LLM:
 *   explicit_save (0.9)          — user asked to remember something (EN + UK)
 *   correction (0.65)            — user opened a turn by correcting the agent
 *   repeated_explanation (0.6)   — user re-explained the same thing in
 *                                  different turns (embedding similarity)
 *
 * Candidates enter quarantine via memoryGovernance.ingest() with source
 * 'auto_transcript' — the EXISTING governance gate (adaptive threshold,
 * promote/reject review) decides what survives. Transcripts are private
 * content: nothing here logs or throws transcript text.
 */

import { embeddingService } from './embedding';
import { memoryGovernance } from './memory-governance';
import { logger } from '../utils/logger';

export type TranscriptRule = 'explicit_save' | 'correction' | 'repeated_explanation';

export interface MineTranscriptOptions {
  transcript: string; // raw JSONL
  projectName: string;
  sessionId: string;
}

export interface TranscriptMineResult {
  linesTotal: number;
  linesUnparseable: number;
  userTexts: number;
  candidates: number;
  ingested: number;
  skippedBelowThreshold: number;
  byRule: Record<TranscriptRule, number>;
}

interface Candidate {
  text: string;
  rule: TranscriptRule;
  confidence: number;
  turnIndex: number;
}

// Caps — junk is contagious: a noisy session must not flood quarantine.
const MAX_USER_TEXTS = 500; // user turns considered per capture
const MAX_EMBED_TEXTS = 200; // texts embedded for repeated_explanation
const MAX_CANDIDATE_CHARS = 1200;
const MAX_CANDIDATES_PER_CAPTURE = 20;

const REPEAT_MIN_CHARS = 80;
const REPEAT_COSINE_THRESHOLD = 0.86;
const CORRECTION_MIN_CHARS = 40;

// Synthetic content injected into user turns by the Claude Code harness —
// never a human statement, never minable.
const SYNTHETIC_MARKERS = [
  '<system-reminder>',
  '<local-command-stdout>',
  '<bash-input>',
  '<bash-stdout>',
  '<command-name>',
  '<task-notification>',
  '<local-command-caveat>',
];

// Save-intent phrases (EN + UK), matched case-insensitively anywhere in the
// turn. Matching runs on an apostrophe-normalized AND apostrophe-stripped
// variant so "запам'ятай" / "запамʼятай" / "запамятай" all hit.
const SAVE_PHRASES = [
  'remember this',
  'remember that',
  'note for the future',
  'keep in mind',
  "запам'ятай",
  'запамятай',
  "збережи в пам'ять",
  'збережи це',
  'на майбутнє врахуй',
];

// Correction markers — the trimmed turn must START with one of these.
const CORRECTION_PREFIXES = [
  'no,',
  'no -',
  "that's wrong",
  'that is wrong',
  'wrong,',
  'actually,',
  'incorrect',
  'ні,',
  'ні.',
  'не так',
  'неправильно',
  'невірно',
  'насправді',
];

/** Unify the apostrophe zoo (’ ʼ ‘ `) onto ASCII ' for phrase matching. */
function normalizeApostrophes(text: string): string {
  return text.replace(/[’ʼ‘`]/g, "'");
}

/** Lowercase + collapse whitespace — used for dedupe and phrase matching. */
function normalizeForMatch(text: string): string {
  return normalizeApostrophes(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesSavePhrase(normalized: string): boolean {
  const stripped = normalized.replace(/'/g, '');
  return SAVE_PHRASES.some((phrase) => {
    const p = phrase.toLowerCase();
    return normalized.includes(p) || stripped.includes(p.replace(/'/g, ''));
  });
}

function matchesCorrectionPrefix(normalized: string): boolean {
  return CORRECTION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Local cosine helper — memory.ts has one but keeps it private. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Extract the human text of one parsed JSONL line, or null when the line is
 * not a real user turn (assistant/meta/tool_result/synthetic/empty).
 */
function extractUserText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user' || entry.isMeta) return null;
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (content === undefined || content === null) return null;

  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Keep text blocks only — tool_result (and any other block type) is
    // machine output, not a human statement.
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        const t = (block as any).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length === 0) return null;
    text = parts.join('\n');
  } else {
    return null;
  }

  if (!text.trim()) return null;
  if (SYNTHETIC_MARKERS.some((marker) => text.includes(marker))) return null;
  return text;
}

class TranscriptMinerService {
  async mine(options: MineTranscriptOptions): Promise<TranscriptMineResult> {
    const { transcript, projectName, sessionId } = options;

    // 1. Parse JSONL defensively — the client may tail-truncate mid-line.
    const lines = transcript.split('\n').filter((line) => line.trim().length > 0);
    let linesUnparseable = 0;
    const userTexts: string[] = [];
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        linesUnparseable++;
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const text = extractUserText(entry);
      if (text !== null) {
        userTexts.push(text);
        if (userTexts.length >= MAX_USER_TEXTS) break;
      }
    }

    // 2. Run the rules.
    const candidates: Candidate[] = [];
    userTexts.forEach((text, turnIndex) => {
      const normalized = normalizeForMatch(text);
      if (matchesSavePhrase(normalized)) {
        candidates.push({ text, rule: 'explicit_save', confidence: 0.9, turnIndex });
      }
      if (text.trim().length >= CORRECTION_MIN_CHARS && matchesCorrectionPrefix(normalized)) {
        candidates.push({ text, rule: 'correction', confidence: 0.65, turnIndex });
      }
    });
    candidates.push(...(await this.findRepeatedExplanations(userTexts)));

    // 3. Post-process: trim + cap length, dedupe (normalized exact match),
    //    keep highest-confidence first, hard-cap per capture.
    const seen = new Set<string>();
    const finalCandidates: Candidate[] = [];
    for (const candidate of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
      const text = candidate.text.trim().slice(0, MAX_CANDIDATE_CHARS);
      const key = normalizeForMatch(text);
      if (seen.has(key)) continue;
      seen.add(key);
      finalCandidates.push({ ...candidate, text });
      if (finalCandidates.length >= MAX_CANDIDATES_PER_CAPTURE) break;
    }

    // 4. Ingest through the governance gate (quarantine; the adaptive
    //    threshold may drop low-confidence candidates → metadata.skipped).
    const byRule: Record<TranscriptRule, number> = {
      explicit_save: 0,
      correction: 0,
      repeated_explanation: 0,
    };
    let ingested = 0;
    let skippedBelowThreshold = 0;
    const capturedAt = new Date().toISOString();
    for (const candidate of finalCandidates) {
      byRule[candidate.rule]++;
      const memory = await memoryGovernance.ingest({
        projectName,
        content: candidate.text,
        type: 'context',
        tags: ['transcript', candidate.rule],
        source: 'auto_transcript',
        confidence: candidate.confidence,
        metadata: { sessionId, rule: candidate.rule, capturedAt },
      });
      if (memory.metadata?.skipped === true) {
        skippedBelowThreshold++;
      } else {
        ingested++;
      }
    }

    const result: TranscriptMineResult = {
      linesTotal: lines.length,
      linesUnparseable,
      userTexts: userTexts.length,
      candidates: finalCandidates.length,
      ingested,
      skippedBelowThreshold,
      byRule,
    };
    // Counts only — transcript text never reaches the logs.
    logger.info('Transcript mined', { project: projectName, sessionId, ...result, byRule });
    return result;
  }

  /**
   * repeated_explanation: embed substantial user turns and cluster pairs with
   * cosine >= threshold from DIFFERENT turns. One candidate per cluster — the
   * LATER text (the re-explanation, presumably the refined version).
   */
  private async findRepeatedExplanations(userTexts: string[]): Promise<Candidate[]> {
    const eligible: Array<{ text: string; turnIndex: number }> = [];
    userTexts.forEach((text, turnIndex) => {
      if (text.trim().length >= REPEAT_MIN_CHARS && eligible.length < MAX_EMBED_TEXTS) {
        eligible.push({ text, turnIndex });
      }
    });
    if (eligible.length < 2) return [];

    const embeddings = await embeddingService.embedBatch(eligible.map((e) => e.text));

    // Union-find over similar pairs → clusters.
    const parent = eligible.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a: number, b: number) => {
      parent[find(a)] = find(b);
    };

    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        if (cosineSimilarity(embeddings[i], embeddings[j]) < REPEAT_COSINE_THRESHOLD) continue;
        // Verbatim re-paste of the same short command is repetition, not a
        // re-explanation — require either different wording or real length.
        if (
          normalizeForMatch(eligible[i].text) === normalizeForMatch(eligible[j].text) &&
          eligible[i].text.trim().length < 120
        ) {
          continue;
        }
        union(i, j);
      }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < eligible.length; i++) {
      const root = find(i);
      const members = clusters.get(root) ?? [];
      members.push(i);
      clusters.set(root, members);
    }

    const candidates: Candidate[] = [];
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      const latest = members.reduce((a, b) =>
        eligible[a].turnIndex >= eligible[b].turnIndex ? a : b
      );
      candidates.push({
        text: eligible[latest].text,
        rule: 'repeated_explanation',
        confidence: 0.6,
        turnIndex: eligible[latest].turnIndex,
      });
    }
    return candidates;
  }
}

export const transcriptMiner = new TranscriptMinerService();
export default transcriptMiner;
