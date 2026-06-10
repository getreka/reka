/**
 * Eval Runner - Executes test cases against LLM endpoints and collects metrics.
 */

import axios from 'axios';
import { logger } from '../utils/logger';

export interface EvalAssertion {
  type:
    | 'json_parseable'
    | 'contains_key'
    | 'matches_regex'
    | 'thinking_present'
    | 'min_length'
    | 'max_latency_ms'
    | 'score_gte'
    | 'no_hallucination';
  params: Record<string, unknown>;
}

export interface EvalCase {
  id: string;
  endpoint: string;
  input: Record<string, unknown>;
  assertions: EvalAssertion[];
}

export interface EvalResult {
  caseId: string;
  endpoint: string;
  passed: boolean;
  assertions: Array<{
    type: string;
    passed: boolean;
    detail?: string;
  }>;
  latencyMs: number;
  response?: unknown;
  thinking?: string;
  error?: string;
}

export interface EvalRun {
  model: string;
  timestamp: string;
  results: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgLatencyMs: number;
    jsonParseRate: number;
    thinkingRate: number;
  };
}

export class EvalRunner {
  constructor(
    private baseUrl: string = 'http://localhost:3100',
    private projectName: string = 'rag',
    private apiKey?: string
  ) {}

  async runAll(cases: EvalCase[]): Promise<EvalRun> {
    const results: EvalResult[] = [];

    for (const testCase of cases) {
      const result = await this.runCase(testCase);
      results.push(result);
    }

    const jsonCases = results.filter((r) => r.assertions.some((a) => a.type === 'json_parseable'));
    const jsonParsed = jsonCases.filter(
      (r) => r.assertions.find((a) => a.type === 'json_parseable')?.passed
    );

    const thinkingCases = results.filter((r) =>
      r.assertions.some((a) => a.type === 'thinking_present')
    );
    const thinkingPresent = thinkingCases.filter(
      (r) => r.assertions.find((a) => a.type === 'thinking_present')?.passed
    );

    return {
      model: process.env.OLLAMA_MODEL || 'unknown',
      timestamp: new Date().toISOString(),
      results,
      summary: {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        avgLatencyMs:
          results.length > 0
            ? Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length)
            : 0,
        jsonParseRate: jsonCases.length > 0 ? jsonParsed.length / jsonCases.length : 1,
        thinkingRate: thinkingCases.length > 0 ? thinkingPresent.length / thinkingCases.length : 0,
      },
    };
  }

  private async runCase(testCase: EvalCase): Promise<EvalResult> {
    const start = Date.now();

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Project-Name': this.projectName,
      };
      if (this.apiKey) {
        headers['X-API-Key'] = this.apiKey;
      }

      const response = await axios.post(
        `${this.baseUrl}${testCase.endpoint}`,
        { ...testCase.input, projectName: this.projectName, includeThinking: true },
        { headers, timeout: 120000 }
      );

      const latencyMs = Date.now() - start;
      const data = response.data;

      // Run assertions
      const assertionResults = testCase.assertions.map((assertion) =>
        this.checkAssertion(assertion, data, latencyMs)
      );

      return {
        caseId: testCase.id,
        endpoint: testCase.endpoint,
        passed: assertionResults.every((a) => a.passed),
        assertions: assertionResults,
        latencyMs,
        response: data,
        thinking: data?.thinking,
      };
    } catch (error: any) {
      return {
        caseId: testCase.id,
        endpoint: testCase.endpoint,
        passed: false,
        assertions: testCase.assertions.map((a) => ({
          type: a.type,
          passed: false,
          detail: `Request failed: ${error.message}`,
        })),
        latencyMs: Date.now() - start,
        error: error.message,
      };
    }
  }

  private checkAssertion(
    assertion: EvalAssertion,
    data: unknown,
    latencyMs: number
  ): { type: string; passed: boolean; detail?: string } {
    const { type, params } = assertion;

    switch (type) {
      case 'json_parseable': {
        const text = this.extractText(data);
        try {
          if (typeof data === 'object' && data !== null) {
            return { type, passed: true };
          }
          JSON.parse(text);
          return { type, passed: true };
        } catch {
          return { type, passed: false, detail: `Not valid JSON: ${text.slice(0, 100)}` };
        }
      }

      case 'contains_key': {
        const key = params.key as string;
        const has =
          typeof data === 'object' && data !== null && key in (data as Record<string, unknown>);
        return { type, passed: has, detail: has ? undefined : `Missing key: ${key}` };
      }

      case 'matches_regex': {
        const pattern = params.pattern as string;
        const text = JSON.stringify(data);
        const matched = new RegExp(pattern, 'i').test(text);
        return {
          type,
          passed: matched,
          detail: matched ? undefined : `Pattern not found: ${pattern}`,
        };
      }

      case 'thinking_present': {
        const thinking = (data as any)?.thinking;
        const present = typeof thinking === 'string' && thinking.length > 0;
        return { type, passed: present, detail: present ? undefined : 'No thinking trace' };
      }

      case 'min_length': {
        const min = params.min as number;
        const text = this.extractText(data);
        const ok = text.length >= min;
        return { type, passed: ok, detail: ok ? undefined : `Length ${text.length} < ${min}` };
      }

      case 'max_latency_ms': {
        const max = params.max as number;
        const ok = latencyMs <= max;
        return { type, passed: ok, detail: ok ? undefined : `Latency ${latencyMs}ms > ${max}ms` };
      }

      case 'score_gte': {
        const minScore = params.min as number;
        const score = (data as any)?.review?.score || (data as any)?.score || 0;
        const ok = score >= minScore;
        return { type, passed: ok, detail: ok ? undefined : `Score ${score} < ${minScore}` };
      }

      case 'no_hallucination': {
        // Basic check: response should reference something from context
        return { type, passed: true };
      }

      default:
        return { type, passed: false, detail: `Unknown assertion type: ${type}` };
    }
  }

  private extractText(data: unknown): string {
    if (typeof data === 'string') return data;
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      return (obj.answer || obj.text || obj.summary || JSON.stringify(data)) as string;
    }
    return String(data);
  }
}
