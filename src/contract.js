'use strict';

// Builds the in-session "reasoning contract" block added to reasoning tool
// output. This module has zero LLM/API code: it returns
// a deep-frozen, statically-authored instruction block that the calling
// model (Claude, in-session) is expected to execute over the brain's
// deterministic tool output.
//
// Hard rule (see docs/superpowers/specs/2026-07-15-brain-reasoning-contracts-design.md):
// every string here is a static, server-authored template. Contracts never
// interpolate KB rows, vault text, GitHub titles, task context, or any other
// external/caller-controlled data into prose. Only whitelisted internal
// identifiers (recommendation keys, degraded-source names, counts) may be
// carried through, and only as opaque entries in dedicated array fields
// (`candidateKeys`, `degradedSources`) -- never spliced into sentence text.

const CONSTRAINTS = Object.freeze([
  'Cite only evidence present in this tool result; name the field you relied on.',
  'State uncertainty explicitly; do not invent metrics, row counts, or statuses.',
  'If evidence health is not `complete`, say which source degraded and how it limits the conclusion.',
  'End with one "what would change this conclusion" condition.',
]);

const RECOMMEND_TEMPLATE = Object.freeze({
  role: 'You are the reasoning layer over a deterministic rule-table synthesizer. It surfaces candidates; it does not judge them.',
  synthesize: 'Rank the candidates against this session\'s live context and produce the judgment the rule table cannot make on its own.',
  steps: Object.freeze([
    'Treat `recommendations` as candidates from a rule table, not conclusions.',
    'Rank each candidate against the current session\'s live context.',
    'Stress-test each candidate\'s `why`: for metric-driven candidates, apply a Goodhart\'s-law check (is the metric being optimized instead of the underlying goal?).',
    'Recommend at most 3 candidates from `candidateKeys`, each with your reasoning.',
    'For each recommended candidate, state the condition that would change your mind about it.',
  ]),
  outputShape: 'For each of at most 3 recommended candidates: the candidate key, your reasoning, and its change-my-mind condition.',
});

const REFRAME_TEMPLATE = Object.freeze({
  role: 'You are the reasoning layer over a deterministic lens + evidence composer. It surfaces a frame and evidence; it does not answer the questions.',
  synthesize: 'Actually answer the lens questions against the cited evidence and produce the verdict the composer cannot make on its own.',
  steps: Object.freeze([
    'Answer `lensAnalysis.coreQuestion` and `lensAnalysis.evidenceCheckQuestion` using only `kbEvidence`.',
    'If `adversarialReview.applied` is true, also answer its red-team, steel-man, and pre-mortem questions.',
    'Emit a verdict of exactly one of: proceed, reframe, reject.',
    'Cite the specific evidence rows that support the verdict.',
    'Name the assumption most likely to be wrong.',
  ]),
  outputShape: 'A verdict (proceed | reframe | reject), the cited evidence rows, and the assumption most likely to be wrong.',
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.getOwnPropertyNames(value).forEach((prop) => deepFreeze(value[prop]));
  return Object.freeze(value);
}

// Whitelisted internal identifiers only: strings, carried through as opaque
// array entries. Never inspected, never joined into prose.
function boundedIdentifierList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string');
}

function buildReasoningContract({ tool, candidateKeys, degradedSources } = {}) {
  if (tool === 'recommend') {
    return deepFreeze({
      contractVersion: 1,
      audience: 'calling-model',
      role: RECOMMEND_TEMPLATE.role,
      synthesize: RECOMMEND_TEMPLATE.synthesize,
      steps: [...RECOMMEND_TEMPLATE.steps],
      constraints: [...CONSTRAINTS],
      outputShape: RECOMMEND_TEMPLATE.outputShape,
      candidateKeys: boundedIdentifierList(candidateKeys),
      degradedSources: boundedIdentifierList(degradedSources),
    });
  }

  if (tool === 'reframe') {
    return deepFreeze({
      contractVersion: 1,
      audience: 'calling-model',
      role: REFRAME_TEMPLATE.role,
      synthesize: REFRAME_TEMPLATE.synthesize,
      steps: [...REFRAME_TEMPLATE.steps],
      constraints: [...CONSTRAINTS],
      outputShape: REFRAME_TEMPLATE.outputShape,
    });
  }

  throw new Error(`buildReasoningContract: unknown tool "${tool}"`);
}

module.exports = { buildReasoningContract };
