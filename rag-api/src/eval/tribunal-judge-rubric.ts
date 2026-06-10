/**
 * LLM-as-Judge rubric for scoring tribunal debate quality.
 *
 * Uses a separate LLM call with structured rubric to evaluate
 * debate outputs objectively.
 */

export interface RubricScore {
  metric: string;
  score: number; // 1-10
  maxScore: number;
  reasoning: string;
}

export interface EvalScorecard {
  caseId: string;
  scores: RubricScore[];
  averageScore: number;
  pass: boolean; // All metrics meet threshold
  details: string;
}

/**
 * Build the LLM-as-judge prompt for evaluating a tribunal debate.
 */
export function buildJudgeRubricPrompt(params: {
  topic: string;
  positions: string[];
  arguments: Array<{ position: string; content: string; round: number }>;
  verdictText: string;
  knownBestPosition?: string;
}): string {
  const { topic, positions, arguments: args, verdictText, knownBestPosition } = params;

  let prompt = `You are evaluating the quality of a structured debate. Score each metric 1-10.

## Debate Topic
${topic}

## Positions
${positions.join(', ')}

## Arguments
`;

  for (const arg of args) {
    const label = arg.round === 0 ? 'Initial' : `Rebuttal R${arg.round}`;
    prompt += `### ${arg.position} (${label})\n${arg.content}\n\n`;
  }

  prompt += `## Verdict\n${verdictText}\n\n`;

  if (knownBestPosition) {
    prompt += `## Ground Truth\nThe expected best position is: "${knownBestPosition}"\n\n`;
  }

  prompt += `## Scoring Rubric

Score each metric 1-10 and provide a one-line justification.

1. **argument_quality**: Do arguments cite concrete evidence (not just opinions)? Are they logically structured?
2. **rebuttal_relevance**: Do rebuttals address specific opponent claims (not generic counter-arguments)?
3. **verdict_completeness**: Does the verdict address all positions, include scoring, and have a clear recommendation?
4. **verdict_consistency**: Does the verdict logically follow from the arguments? No self-contradictions?
5. **actionability**: Is the recommendation concrete and implementable (not "it depends")?
6. **dissent_quality**: Does the dissent capture the strongest counter-argument from the losing side?
7. **evidence_depth**: Are claims backed by quantitative data, benchmarks, or concrete examples?
8. **balance**: Were all positions given fair consideration, or was the debate one-sided?

Respond in this EXACT JSON format:
{
  "scores": [
    { "metric": "argument_quality", "score": N, "reasoning": "..." },
    { "metric": "rebuttal_relevance", "score": N, "reasoning": "..." },
    { "metric": "verdict_completeness", "score": N, "reasoning": "..." },
    { "metric": "verdict_consistency", "score": N, "reasoning": "..." },
    { "metric": "actionability", "score": N, "reasoning": "..." },
    { "metric": "dissent_quality", "score": N, "reasoning": "..." },
    { "metric": "evidence_depth", "score": N, "reasoning": "..." },
    { "metric": "balance", "score": N, "reasoning": "..." }
  ]
}`;

  return prompt;
}

/** Thresholds for each metric (minimum score to pass) */
export const METRIC_THRESHOLDS: Record<string, number> = {
  argument_quality: 7, // ≥ 7/10
  rebuttal_relevance: 6, // ≥ 6/10
  verdict_completeness: 7, // ≥ 7/10
  verdict_consistency: 7, // ≥ 7/10
  actionability: 7, // ≥ 7/10
  dissent_quality: 6, // ≥ 6/10
  evidence_depth: 6, // ≥ 6/10
  balance: 7, // ≥ 7/10
};

/**
 * Parse LLM judge response into scored rubric.
 */
export function parseJudgeResponse(caseId: string, responseText: string): EvalScorecard {
  try {
    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = responseText.match(/\{[\s\S]*"scores"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in judge response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const scores: RubricScore[] = (parsed.scores || []).map((s: any) => ({
      metric: s.metric,
      score: Math.min(10, Math.max(1, Number(s.score) || 5)),
      maxScore: 10,
      reasoning: s.reasoning || '',
    }));

    const averageScore =
      scores.length > 0 ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length : 0;

    const pass = scores.every((s) => {
      const threshold = METRIC_THRESHOLDS[s.metric] || 6;
      return s.score >= threshold;
    });

    return {
      caseId,
      scores,
      averageScore: Math.round(averageScore * 100) / 100,
      pass,
      details: scores.map((s) => `${s.metric}: ${s.score}/10 — ${s.reasoning}`).join('\n'),
    };
  } catch (error: any) {
    return {
      caseId,
      scores: [],
      averageScore: 0,
      pass: false,
      details: `Failed to parse judge response: ${error.message}`,
    };
  }
}
