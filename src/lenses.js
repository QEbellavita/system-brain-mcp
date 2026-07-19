'use strict';

// Composition layer: turns a registry lens + selector decision + bounded KB
// evidence into an immutable, schema-version-1 "lens packet". This module
// never mutates caller input, never emits raw prompt text, absolute paths,
// quotes, or KB instructions, and only asserts what KB evidence directly
// supports -- everything else stays a bounded question.

const crypto = require('crypto');
const { listLenses: listRegistryLenses } = require('./lens-registry');
const { selectLens } = require('./lens-selector');
const { normalizeTaskContext, normalizeRecommendation } = require('./taxonomy');
const { buildReasoningContract } = require('./contract');

const SCHEMA_VERSION = 1;
const EVIDENCE_STATES = ['complete', 'partial', 'failed', 'stale'];
const REVIEW_RISK_TAGS = ['security', 'privacy', 'authentication', 'data-deletion', 'production', 'irreversible'];
const ADVERSARIAL_QUESTIONS = Object.freeze({
  redTeam: Object.freeze(['What evidence would show this recommendation is wrong or unsafe?']),
  steelMan: Object.freeze(['What is the strongest evidence-backed case for the proposed action?']),
  preMortem: Object.freeze(['Assume this action failed: which current assumption most likely caused it?']),
});

const SKIPPED_BECAUSE = 'Skipped: low-risk, bounded work matched no adversarial review triggers.';
const APPLY_GUIDANCE = 'Pick the 1-2 lenses whose coreQuestion bites hardest on the live problem and apply them via '
  + 'a reframing step (or directly) -- do not treat this list as reference material only.';
const KB_CAPS = Object.freeze({
  concepts: 6,
  links: 8,
  articles: 4,
  sources: 4,
});
const KB_STRING_CAPS = Object.freeze({
  long: 600,
  short: 180,
  url: 500,
  path: 240,
});
const MAX_PACKET_STRING = 4096;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
const ABSOLUTE_PATH_TEXT = /(^|[\s"'`([{:=])(?:\/(?!\/)\S+|[A-Za-z]:[\\/]|\\\\)/;
const UNSAFE_URL_TEXT = /(^|[\s"'`([{])(?:javascript|data|file|ftp):/i;
const INSTRUCTION_LIKE_TEXT = /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|developer|system)\s+instructions\b|\b(?:reveal|print|exfiltrate|dump)\b.{0,80}\b(?:system prompt|developer instructions|private|secret|database|file path)\b|\bsystem prompt\b/i;

// --- small utilities ---------------------------------------------------------

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.getOwnPropertyNames(value).forEach((prop) => deepFreeze(value[prop]));
  return Object.freeze(value);
}

function safePacketScalar(value) {
  if (typeof value === 'string') {
    return value.length <= MAX_PACKET_STRING
      && !CONTROL_CHARACTER.test(value)
      && !ABSOLUTE_PATH_TEXT.test(value)
      && !UNSAFE_URL_TEXT.test(value)
      && !INSTRUCTION_LIKE_TEXT.test(value);
  }
  return value === null || ['boolean', 'number'].includes(typeof value);
}

function isPlainDataRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownPacketValue(source, field) {
  if (!isPlainDataRecord(source)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function sanitizePacketString(value, max, { required = false, path = false, url = false } = {}) {
  if (value === null || value === undefined) return required ? null : '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  if (trimmed.length > MAX_PACKET_STRING
    || CONTROL_CHARACTER.test(trimmed)
    || ABSOLUTE_PATH_TEXT.test(trimmed)
    || UNSAFE_URL_TEXT.test(trimmed)
    || INSTRUCTION_LIKE_TEXT.test(trimmed)) return null;
  if (path && trimmed.startsWith('/')) return null;
  if (url && trimmed) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  }
  return trimmed.slice(0, max);
}

function sanitizePacketId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizePacketStrength(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeConceptRow(row) {
  if (!isPlainDataRecord(row)) return null;
  const id = sanitizePacketId(ownPacketValue(row, 'id'));
  let articleId = null;
  const rawArticleId = ownPacketValue(row, 'articleId');
  if (rawArticleId !== null && rawArticleId !== undefined) {
    articleId = sanitizePacketId(rawArticleId);
    if (articleId === null) return null;
  }
  const name = sanitizePacketString(ownPacketValue(row, 'name'), KB_STRING_CAPS.short, { required: true });
  const domain = sanitizePacketString(ownPacketValue(row, 'domain'), KB_STRING_CAPS.short);
  const definition = sanitizePacketString(ownPacketValue(row, 'definition'), KB_STRING_CAPS.long);
  const articlePath = sanitizePacketString(ownPacketValue(row, 'articlePath'), KB_STRING_CAPS.path, { path: true });
  if (id === null || name === null || domain === null || definition === null || articlePath === null) return null;
  return {
    id,
    name,
    domain,
    definition,
    articleId,
    ...(articlePath ? { articlePath } : {}),
  };
}

function sanitizeLinkRow(row) {
  if (!isPlainDataRecord(row)) return null;
  const fromConceptId = sanitizePacketId(ownPacketValue(row, 'fromConceptId'));
  const toConceptId = sanitizePacketId(ownPacketValue(row, 'toConceptId'));
  const relation = sanitizePacketString(ownPacketValue(row, 'relation'), KB_STRING_CAPS.short, { required: true });
  const context = sanitizePacketString(ownPacketValue(row, 'context'), KB_STRING_CAPS.long);
  if (fromConceptId === null || toConceptId === null || relation === null || context === null) return null;
  return {
    fromConceptId,
    toConceptId,
    relation,
    strength: sanitizePacketStrength(ownPacketValue(row, 'strength')),
    context,
  };
}

function sanitizeArticleRow(row) {
  if (!isPlainDataRecord(row)) return null;
  const id = sanitizePacketId(ownPacketValue(row, 'id'));
  const path = sanitizePacketString(ownPacketValue(row, 'path'), KB_STRING_CAPS.path, { required: true, path: true });
  const domain = sanitizePacketString(ownPacketValue(row, 'domain'), KB_STRING_CAPS.short, { required: true });
  const title = sanitizePacketString(ownPacketValue(row, 'title'), KB_STRING_CAPS.short, { required: true });
  const summary = sanitizePacketString(ownPacketValue(row, 'summary'), KB_STRING_CAPS.long);
  if (id === null || path === null || domain === null || title === null || summary === null) return null;
  return { id, path, domain, title, summary };
}

function sanitizeSourceRow(row) {
  if (!isPlainDataRecord(row)) return null;
  const id = sanitizePacketId(ownPacketValue(row, 'id'));
  const type = sanitizePacketString(ownPacketValue(row, 'type'), KB_STRING_CAPS.short, { required: true });
  const domain = sanitizePacketString(ownPacketValue(row, 'domain'), KB_STRING_CAPS.short);
  const title = sanitizePacketString(ownPacketValue(row, 'title'), KB_STRING_CAPS.short);
  const url = sanitizePacketString(ownPacketValue(row, 'url'), KB_STRING_CAPS.url, { url: true });
  if (id === null || type === null || domain === null || title === null || url === null) return null;
  return { id, type, domain, title, url };
}

function descriptorHasValue(descriptor) {
  return Boolean(descriptor) && Object.hasOwn(descriptor, 'value');
}

function isArrayIndexPropertyName(name) {
  if (typeof name !== 'string' || name === '') return false;
  const index = Number(name);
  return Number.isInteger(index)
    && index >= 0
    && index < 4294967295
    && String(index) === name;
}

function copyDenseOwnDataArray(value, cap) {
  if (!Array.isArray(value)) return { rows: [], changed: value !== undefined };
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!descriptorHasValue(lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0) {
      return { rows: [], changed: true };
    }

    const length = lengthDescriptor.value;
    const propertyNames = Object.getOwnPropertyNames(value);
    let indexPropertyCount = 0;
    for (const propertyName of propertyNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
      if (!descriptorHasValue(descriptor)) return { rows: [], changed: true };
      if (propertyName === 'length') continue;
      if (!isArrayIndexPropertyName(propertyName)) return { rows: [], changed: true };
      if (Number(propertyName) >= length) return { rows: [], changed: true };
      indexPropertyCount += 1;
    }
    if (indexPropertyCount !== length) return { rows: [], changed: true };

    for (const symbol of Object.getOwnPropertySymbols(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
      if (!descriptorHasValue(descriptor)) return { rows: [], changed: true };
      return { rows: [], changed: true };
    }

    const rows = [];
    const rowLimit = Math.min(length, cap);
    for (let index = 0; index < rowLimit; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptorHasValue(descriptor)) return { rows: [], changed: true };
      rows.push(descriptor.value);
    }
    return { rows, changed: length > cap };
  } catch (error) {
    return { rows: [], changed: true };
  }
}

function sanitizePacketRows(value, cap, sanitizeRow) {
  const copied = copyDenseOwnDataArray(value, cap);
  const rows = [];
  let changed = copied.changed;
  for (let index = 0; index < copied.rows.length; index += 1) {
    let sanitized = null;
    try {
      sanitized = sanitizeRow(copied.rows[index]);
    } catch (error) {
      sanitized = null;
    }
    if (sanitized) {
      rows.push(sanitized);
    } else {
      changed = true;
    }
  }
  return { rows, changed };
}

function sanitizeKbEvidence(value) {
  const emptyEvidence = { concepts: [], links: [], articles: [], sources: [] };
  try {
    if (!isPlainDataRecord(value)) {
      return { evidence: emptyEvidence, changed: value !== undefined };
    }
    const evidenceArray = (field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor) return { value: undefined, changed: false };
      if (!descriptorHasValue(descriptor)) return { value: undefined, changed: true };
      return { value: descriptor.value, changed: false };
    };
    const rawConcepts = evidenceArray('concepts');
    const rawLinks = evidenceArray('links');
    const rawArticles = evidenceArray('articles');
    const rawSources = evidenceArray('sources');
    const concepts = sanitizePacketRows(rawConcepts.value, KB_CAPS.concepts, sanitizeConceptRow);
    const links = sanitizePacketRows(rawLinks.value, KB_CAPS.links, sanitizeLinkRow);
    const articles = sanitizePacketRows(rawArticles.value, KB_CAPS.articles, sanitizeArticleRow);
    const sources = sanitizePacketRows(rawSources.value, KB_CAPS.sources, sanitizeSourceRow);
    return {
      evidence: {
        concepts: concepts.rows,
        links: links.rows,
        articles: articles.rows,
        sources: sources.rows,
      },
      changed: rawConcepts.changed
        || rawLinks.changed
        || rawArticles.changed
        || rawSources.changed
        || concepts.changed
        || links.changed
        || articles.changed
        || sources.changed,
    };
  } catch (error) {
    return { evidence: emptyEvidence, changed: true };
  }
}

function evidenceHasSupport(kbEvidence) {
  return Object.values(kbEvidence).some((rows) => Array.isArray(rows) && rows.length > 0);
}

function ownBoolean(source, field) {
  return ownPacketValue(source, field) === true;
}

function sanitizeEvidenceHealth(value, { evidenceSanitized = false, supportFound = false } = {}) {
  const source = isPlainDataRecord(value) ? value : {};
  const rawReason = sanitizePacketString(ownPacketValue(source, 'reason'), KB_STRING_CAPS.short);
  const stale = ownBoolean(source, 'stale');
  const failed = ownBoolean(source, 'failed');
  const partial = ownBoolean(source, 'partial');
  const complete = ownBoolean(source, 'complete');
  const ok = ownBoolean(source, 'ok');
  let reason = rawReason || '';
  let state;

  if (evidenceSanitized) {
    state = 'partial';
    reason = 'knowledge evidence sanitized';
  } else if (stale) {
    state = 'stale';
  } else if (failed) {
    state = 'failed';
  } else if (partial) {
    state = 'partial';
  } else if (complete || ok) {
    state = 'complete';
  } else {
    state = 'failed';
  }

  const sanitized = {
    ok: state === 'complete',
    complete: state === 'complete',
    partial: state === 'partial',
    failed: state === 'failed',
    ...(state === 'stale' ? { stale: true } : {}),
    supportFound: Boolean(supportFound),
  };
  if (reason) sanitized.reason = reason;
  return sanitized;
}

// Accept only complete/partial/failed/stale as internal evidence states.
// Any unknown value (string or malformed health object) fails closed to
// 'failed' -- never fails open to 'complete'.
function resolveHealthState(evidenceHealth) {
  if (typeof evidenceHealth === 'string') {
    return EVIDENCE_STATES.includes(evidenceHealth) ? evidenceHealth : 'failed';
  }
  const source = evidenceHealth && typeof evidenceHealth === 'object' ? evidenceHealth : {};
  if (source.stale === true) return 'stale';
  if (source.complete === true) return 'complete';
  if (source.partial === true) return 'partial';
  if (source.failed === true) return 'failed';
  return 'failed';
}

// --- task-only synthetic subject --------------------------------------------

function taskOnlyOriginal(task) {
  const key = `task-${crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex').slice(0, 16)}`;
  const summary = [...task.systems, ...task.workTypes].join(', ');
  return {
    key,
    priority: 'medium',
    category: 'completion-gap',
    title: 'Active task',
    why: `Sanitized task context: ${summary || 'bounded work item'}`,
    action: 'Apply the selected reasoning check to the next finish-line action.',
    evidenceSources: ['task-context'],
    systems: task.systems,
    phases: task.phases,
  };
}

// --- selector flags -----------------------------------------------------------

function deriveFlags(original, task, evidenceState) {
  const evidenceSources = Array.isArray(original.evidenceSources) ? original.evidenceSources : [];
  const originalSystems = Array.isArray(original.systems) ? original.systems : [];
  const taskWorkTypes = Array.isArray(task.workTypes) ? task.workTypes : [];
  const taskRiskTags = Array.isArray(task.riskTags) ? task.riskTags : [];
  return [
    (evidenceSources.includes('analytics') || originalSystems.includes('dashboard')) && 'metrics',
    evidenceState !== 'complete' && 'evidence-uncertain',
    originalSystems.length >= 3 && 'cross-system',
    original.category === 'integration-gap' && 'constraint',
    original.key.includes('feedback') && 'feedback',
    (taskWorkTypes.includes('enhancement') && originalSystems.includes('api')) && 'architecture',
    (original.category === 'launch-blocker' && originalSystems.includes('delivery')) && 'stakeholder',
    taskRiskTags.includes('authentication') && 'incentives',
    (original.category === 'enhancement' && originalSystems.includes('dashboard')) && 'product-value',
    (originalSystems.length >= 3 && taskWorkTypes.includes('fix')) && 'complexity',
  ].filter(Boolean).sort();
}

// --- conditional adversarial review -------------------------------------------

function shouldApplyAdversarialReview({ original, taskContext, evidenceHealth } = {}) {
  const task = taskContext && typeof taskContext === 'object' ? taskContext : {};
  const riskTags = Array.isArray(task.riskTags) ? task.riskTags : [];
  const originalSystems = Array.isArray(original.systems) ? original.systems : [];
  const originalPhases = Array.isArray(original.phases) ? original.phases : [];
  const healthState = resolveHealthState(evidenceHealth);

  const triggers = [
    original.priority === 'high' && 'high-priority',
    ['launch-blocker', 'verified-failure'].includes(original.category) && original.category,
    riskTags.some((tag) => REVIEW_RISK_TAGS.includes(tag)) && 'risk-tag',
    originalSystems.length >= 3 && 'cross-system',
    originalPhases.length >= 2 && 'cross-phase',
    ['partial', 'failed', 'stale'].includes(healthState) && 'evidence-uncertain',
  ].filter(Boolean);

  if (triggers.length === 0) {
    return { applied: false, triggers, skippedBecause: SKIPPED_BECAUSE };
  }
  return { applied: true, triggers };
}

// --- service -------------------------------------------------------------------

function createReasoningLensService({ kbAdapter }) {
  async function listLenses(options = {}) {
    let evidenceHealth;
    try {
      const status = await kbAdapter.getStatus();
      const source = isPlainDataRecord(status) ? status : {};
      evidenceHealth = ownPacketValue(source, 'evidenceHealth');
    } catch (error) {
      evidenceHealth = {
        ok: false, complete: false, partial: false, failed: true,
        reason: 'knowledge status unavailable', supportFound: false,
      };
    }
    return {
      lenses: listRegistryLenses(options),
      evidenceHealth: sanitizeEvidenceHealth(evidenceHealth),
      applyGuidance: APPLY_GUIDANCE,
    };
  }

  async function reframe(options = {}) {
    const { recommendation, taskContext, lens = 'auto', evidenceState = 'complete' } = options || {};
    const task = normalizeTaskContext(taskContext);
    const normalizedEvidenceState = resolveHealthState(evidenceState);

    let rawOriginal;
    let normalizedOriginal;
    if (recommendation !== undefined) {
      const normalized = normalizeRecommendation(recommendation);
      if (!normalized) throw new Error('invalid recommendation');
      normalizedOriginal = normalized;
      rawOriginal = deepClone(normalized);
    } else {
      const synthetic = taskOnlyOriginal(task);
      normalizedOriginal = synthetic;
      rawOriginal = synthetic;
    }

    const flags = deriveFlags(normalizedOriginal, task, normalizedEvidenceState);
    const subject = {
      priority: normalizedOriginal.priority,
      category: normalizedOriginal.category,
      systems: Array.isArray(normalizedOriginal.systems) ? normalizedOriginal.systems : [],
      phases: Array.isArray(normalizedOriginal.phases) ? normalizedOriginal.phases : [],
      workTypes: task.workTypes,
      riskTags: task.riskTags,
      flags,
    };

    const selection = selectLens({ mode: lens, subject });
    if (selection.disabled) {
      return Object.freeze({ disabled: true });
    }
    if (!selection.lens) {
      return deepFreeze({
        noRelevantLens: true,
        selection: {
          mode: selection.mode,
          score: selection.score,
          selectedBecause: ['no relevant lens for normalized subject'],
        },
      });
    }

    // The KB lookup has no dependency on the adversarial gate, so it runs
    // first: the gate must see the adapter's REAL evidence health, not just
    // the caller-declared one, or a stale/failed lookup renders as fresh,
    // confirmed, low-risk support. A rejecting adapter must never let its raw
    // error message (which can carry absolute paths) escape this call --
    // fail closed to the same bounded, private evidenceHealth shape used
    // elsewhere in this module.
    let kbEvidence;
    let evidenceHealth;
    try {
      const adapterResult = await kbAdapter.getEvidence({
        cacheKey: normalizedOriginal.key,
        terms: selection.lens.searchTerms,
      });
      const adapterSource = isPlainDataRecord(adapterResult) ? adapterResult : {};
      kbEvidence = ownPacketValue(adapterSource, 'kbEvidence');
      evidenceHealth = ownPacketValue(adapterSource, 'evidenceHealth');
    } catch (error) {
      kbEvidence = { concepts: [], links: [], articles: [], sources: [] };
      evidenceHealth = {
        ok: false, complete: false, partial: false, failed: true,
        reason: 'knowledge evidence unavailable', supportFound: false,
      };
    }
    const sanitizedEvidence = sanitizeKbEvidence(kbEvidence);
    kbEvidence = sanitizedEvidence.evidence;
    evidenceHealth = sanitizeEvidenceHealth(evidenceHealth, {
      evidenceSanitized: sanitizedEvidence.changed,
      supportFound: evidenceHasSupport(kbEvidence),
    });

    const observedHealthState = resolveHealthState(evidenceHealth);
    const gateEvidenceState = observedHealthState !== 'complete' ? observedHealthState : normalizedEvidenceState;

    const adversarial = shouldApplyAdversarialReview({
      original: normalizedOriginal,
      taskContext: task,
      evidenceHealth: gateEvidenceState,
    });

    const packet = {
      schemaVersion: SCHEMA_VERSION,
      original: rawOriginal,
      selection: {
        lensKey: selection.lens.key,
        mode: selection.mode,
        score: selection.score,
        scoreBreakdown: selection.scoreBreakdown,
        selectedBecause: selection.selectedBecause,
        ...(selection.counterLensKey ? { counterLensKey: selection.counterLensKey } : {}),
      },
      lensAnalysis: {
        name: selection.lens.name,
        kind: selection.lens.kind,
        description: selection.lens.description,
        coreQuestion: selection.lens.questions.core,
        evidenceCheckQuestion: selection.lens.questions.evidenceCheck,
        actionTemplate: selection.lens.actionTemplate,
        limitations: selection.lens.limitations,
      },
      adversarialReview: adversarial.applied
        ? { applied: true, triggers: adversarial.triggers, ...ADVERSARIAL_QUESTIONS }
        : { applied: false, triggers: adversarial.triggers, skippedBecause: adversarial.skippedBecause },
      kbEvidence,
      evidenceHealth,
      reasoning: buildReasoningContract({ tool: 'reframe' }),
    };

    return deepFreeze(packet);
  }

  return { listLenses, reframe };
}

module.exports = {
  createReasoningLensService,
  shouldApplyAdversarialReview,
};
