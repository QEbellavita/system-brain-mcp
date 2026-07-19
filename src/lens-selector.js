'use strict';

const { LENSES, getLens } = require('./lens-registry');

const LENS_INDEX = new Map(LENSES.map((lens, index) => [lens.key, index]));

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareStrings);
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => typeof value === 'number'))].sort((left, right) => left - right);
}

function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function normalizeSubject(subject) {
  const source = subject && typeof subject === 'object' ? subject : {};
  return {
    priority: text(source.priority),
    category: text(source.category),
    systems: uniqueSorted(array(source.systems).filter((value) => typeof value === 'string')),
    phases: uniqueSortedNumbers(array(source.phases)),
    workTypes: uniqueSorted(array(source.workTypes).filter((value) => typeof value === 'string')),
    riskTags: uniqueSorted(array(source.riskTags).filter((value) => typeof value === 'string')),
    flags: uniqueSorted(array(source.flags).filter((value) => typeof value === 'string')),
  };
}

function scoreLens(lens, subject) {
  const scoreBreakdown = {
    category: lens.signals.categories.includes(subject.category) ? 5 : 0,
    workTypes: overlap(lens.signals.workTypes, subject.workTypes).length * 4,
    systems: overlap(lens.signals.systems, subject.systems).length * 3,
    riskTags: overlap(lens.signals.riskTags, subject.riskTags).length * 4,
    phases: overlap(lens.signals.phases, subject.phases).length,
    priority: subject.priority === 'high' && lens.signals.priorities.includes('high') ? 2 : 0,
    flags: overlap(lens.signals.flags || [], subject.flags || []).length * 4,
  };
  scoreBreakdown.total = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  return scoreBreakdown;
}

function compareCandidates(left, right) {
  if (left.scoreBreakdown.total !== right.scoreBreakdown.total) {
    return right.scoreBreakdown.total - left.scoreBreakdown.total;
  }
  const leftIndex = LENS_INDEX.get(left.lens.key);
  const rightIndex = LENS_INDEX.get(right.lens.key);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return compareStrings(left.lens.key, right.lens.key);
}

function selectedBecauseFor(lens, subject, scoreBreakdown) {
  const reasons = [];
  if (scoreBreakdown.category > 0) reasons.push(`category matches: ${subject.category}`);
  if (scoreBreakdown.workTypes > 0) reasons.push(`work type overlap: ${overlap(lens.signals.workTypes, subject.workTypes).join(', ')}`);
  if (scoreBreakdown.systems > 0) reasons.push(`system overlap: ${overlap(lens.signals.systems, subject.systems).join(', ')}`);
  if (scoreBreakdown.riskTags > 0) reasons.push(`risk tag overlap: ${overlap(lens.signals.riskTags, subject.riskTags).join(', ')}`);
  if (scoreBreakdown.phases > 0) reasons.push(`phase overlap: ${overlap(lens.signals.phases, subject.phases).join(', ')}`);
  if (scoreBreakdown.priority > 0) reasons.push('subject priority is high');
  if (scoreBreakdown.flags > 0) reasons.push(`flag overlap: ${overlap(lens.signals.flags || [], subject.flags || []).join(', ')}`);
  return reasons;
}

function counterGateMet(subject) {
  return subject.systems.length >= 3 || subject.phases.length >= 2;
}

function counterLensKeyFor(lens, subject) {
  if (!counterGateMet(subject)) return undefined;
  const [declaredCounter] = lens.counterLensKeys;
  return declaredCounter;
}

function selectLens({ mode = 'auto', subject } = {}) {
  const normalizedSubject = normalizeSubject(subject);
  const normalizedMode = text(mode).trim() || 'auto';

  if (normalizedMode === 'off') {
    return { disabled: true, mode: 'off' };
  }

  if (normalizedMode === 'auto') {
    const candidates = LENSES.map((lens) => {
      const scoreBreakdown = scoreLens(lens, normalizedSubject);
      return { lens, scoreBreakdown };
    }).sort(compareCandidates);
    const [best] = candidates;
    if (!best || best.scoreBreakdown.total === 0) {
      return {
        ok: false,
        mode: 'auto',
        score: 0,
        reason: 'no relevant lens',
      };
    }
    const counterLensKey = counterLensKeyFor(best.lens, normalizedSubject);
    return {
      lens: best.lens,
      mode: 'auto',
      score: best.scoreBreakdown.total,
      scoreBreakdown: best.scoreBreakdown,
      selectedBecause: selectedBecauseFor(best.lens, normalizedSubject, best.scoreBreakdown),
      ...(counterLensKey ? { counterLensKey } : {}),
    };
  }

  const lens = getLens(normalizedMode);
  if (!lens) {
    throw new Error('unknown lens');
  }
  const scoreBreakdown = scoreLens(lens, normalizedSubject);
  const counterLensKey = counterLensKeyFor(lens, normalizedSubject);
  return {
    lens,
    mode: normalizedMode,
    score: scoreBreakdown.total,
    scoreBreakdown,
    selectedBecause: ['explicit lens selection'],
    ...(counterLensKey ? { counterLensKey } : {}),
  };
}

module.exports = {
  selectLens,
};
