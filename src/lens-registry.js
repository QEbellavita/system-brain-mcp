'use strict';

const FRAMING_LIMITATION = 'A framing aid, not evidence.';
const THINKER_LIMITATION = 'Inspired analytical frame only; not an impersonation, quotation, or endorsement.';

function searchTerms(text) {
  const seen = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!seen.includes(token)) seen.push(token);
  }
  return Object.freeze(seen.slice(0, 8));
}

function signals(spec) {
  return Object.freeze({
    priorities: Object.freeze([...spec.priorities]),
    categories: Object.freeze([...spec.categories]),
    workTypes: Object.freeze([...spec.workTypes]),
    systems: Object.freeze([...spec.systems]),
    phases: Object.freeze([...spec.phases]),
    riskTags: Object.freeze([...spec.riskTags]),
    flags: Object.freeze([...(spec.flags || [])]),
  });
}

// Signal hints are expressed in the DEFAULT taxonomy's vocabulary
// (config/taxonomy.default.json). If you replace that taxonomy, update these
// or set them empty — an unmatched hint simply never fires.
const SIGNALS = {
  'goodharts-law': { priorities: ['high'], categories: [], workTypes: ['verification'], systems: ['frontend'], phases: [4, 5], riskTags: [], flags: ['metrics'] },
  'circle-of-competence': { priorities: ['high'], categories: [], workTypes: ['verification'], systems: [], phases: [], riskTags: [], flags: ['evidence-uncertain'] },
  'second-order-thinking': { priorities: ['high'], categories: ['integration-gap'], workTypes: ['enhancement'], systems: ['api', 'frontend', 'jobs'], phases: [1, 2, 3, 4, 5, 6], riskTags: [], flags: ['cross-system'] },
  'occams-razor': { priorities: [], categories: ['cleanup'], workTypes: ['fix'], systems: [], phases: [], riskTags: [], flags: ['complexity'] },
  'bayesian-updating': { priorities: ['high'], categories: [], workTypes: ['verification'], systems: ['data'], phases: [3, 6], riskTags: [], flags: ['evidence-uncertain'] },
  'ooda-loop': { priorities: ['high'], categories: ['verified-failure'], workTypes: ['fix', 'deployment'], systems: ['infra'], phases: [5, 6], riskTags: [], flags: ['feedback'] },
  antifragility: { priorities: [], categories: ['verified-failure'], workTypes: ['enhancement'], systems: ['data'], phases: [6], riskTags: [], flags: ['feedback'] },
  inversion: { priorities: ['high'], categories: ['launch-blocker', 'verified-failure'], workTypes: ['deployment', 'verification'], systems: ['infra'], phases: [5], riskTags: ['security', 'privacy', 'auth', 'data-loss', 'production', 'irreversible'], flags: [] },
  'bottleneck-theory': { priorities: ['high'], categories: ['integration-gap'], workTypes: ['fix', 'deployment'], systems: ['infra'], phases: [5], riskTags: [], flags: ['constraint'] },
  'first-principles-thinking': { priorities: [], categories: ['enhancement'], workTypes: ['enhancement'], systems: ['api'], phases: [2, 3], riskTags: [], flags: ['architecture'] },
  'taleb-inspired': { priorities: ['high'], categories: ['launch-blocker'], workTypes: ['deployment'], systems: ['infra'], phases: [5], riskTags: ['production', 'irreversible'], flags: ['evidence-uncertain'] },
  'carnegie-inspired': { priorities: [], categories: ['launch-blocker'], workTypes: ['deployment'], systems: ['infra'], phases: [5], riskTags: [], flags: ['stakeholder'] },
  'greene-inspired': { priorities: [], categories: ['integration-gap'], workTypes: ['verification'], systems: ['api'], phases: [5], riskTags: ['auth'], flags: ['incentives'] },
  'hormozi-inspired': { priorities: [], categories: ['enhancement'], workTypes: ['enhancement'], systems: ['frontend'], phases: [5], riskTags: [], flags: ['product-value'] },
  'deming-inspired': { priorities: ['high'], categories: ['integration-gap'], workTypes: ['verification'], systems: ['data', 'frontend'], phases: [4, 6], riskTags: [], flags: ['feedback', 'metrics'] },
};

function mentalModel(spec) {
  return Object.freeze({
    key: spec.key,
    kind: 'mental-model',
    name: spec.name,
    description: spec.description,
    questions: Object.freeze({ core: spec.coreQuestion, evidenceCheck: spec.evidenceCheckQuestion }),
    actionTemplate: spec.actionTemplate,
    searchTerms: searchTerms(spec.searchTermsText),
    signals: signals(SIGNALS[spec.key]),
    counterLensKeys: Object.freeze(spec.counterLensKey ? [spec.counterLensKey] : []),
    limitations: Object.freeze([FRAMING_LIMITATION]),
  });
}

function thinkerInspired(spec) {
  return Object.freeze({
    key: spec.key,
    kind: 'thinker-inspired',
    name: spec.name,
    description: spec.description,
    questions: Object.freeze({ core: spec.coreQuestion, evidenceCheck: spec.evidenceCheckQuestion }),
    actionTemplate: spec.actionTemplate,
    searchTerms: searchTerms(spec.searchTermsText),
    signals: signals(SIGNALS[spec.key]),
    counterLensKeys: Object.freeze(spec.counterLensKey ? [spec.counterLensKey] : []),
    limitations: Object.freeze([FRAMING_LIMITATION, THINKER_LIMITATION]),
  });
}

const LENSES = Object.freeze([
  mentalModel({
    key: 'goodharts-law',
    name: "Goodhart's Law",
    description: 'Tests whether a measured proxy can improve while the real product outcome degrades.',
    coreQuestion: 'What could improve on the measured proxy while the real outcome gets worse?',
    evidenceCheckQuestion: 'Which independent outcome measure would detect proxy gaming?',
    actionTemplate: 'Name the real outcome, the proxy, and one independent verification measure before optimizing it.',
    searchTermsText: 'metric proxy outcome evaluation',
    counterLensKey: 'deming-inspired',
  }),
  mentalModel({
    key: 'circle-of-competence',
    name: 'Circle of Competence',
    description: 'Separates verified capability from assumptions that require more evidence or expertise.',
    coreQuestion: 'Which part is verified competence, and which part still requires evidence or expertise?',
    evidenceCheckQuestion: 'What observation or expert review is still missing?',
    actionTemplate: 'Mark each claim verified, inferred, or outside current competence before acting.',
    searchTermsText: 'uncertainty evidence calibration limitation',
    counterLensKey: 'first-principles-thinking',
  }),
  mentalModel({
    key: 'second-order-thinking',
    name: 'Second-Order Thinking',
    description: 'Examines downstream consequences across connected systems and pipeline phases.',
    coreQuestion: 'What happens after the immediate fix across connected systems and phases?',
    evidenceCheckQuestion: 'Which downstream consumer or feedback path could regress after the immediate fix?',
    actionTemplate: 'Trace one additional consequence through each affected system before shipping.',
    searchTermsText: 'downstream effect system interaction',
    counterLensKey: 'occams-razor',
  }),
  mentalModel({
    key: 'occams-razor',
    name: "Occam's Razor",
    description: 'Seeks the smallest explanation and intervention consistent with all healthy evidence.',
    coreQuestion: 'What is the smallest explanation and intervention consistent with all evidence?',
    evidenceCheckQuestion: 'What evidence rules out the simpler explanation?',
    actionTemplate: 'Test the simplest complete explanation before adding architecture or state.',
    searchTermsText: 'simplicity parsimonious architecture',
    counterLensKey: 'second-order-thinking',
  }),
  mentalModel({
    key: 'bayesian-updating',
    name: 'Bayesian Updating',
    description: 'Frames decisions as explicit belief changes in response to new evidence.',
    coreQuestion: 'What prior belief should change, by how much, after this evidence?',
    evidenceCheckQuestion: 'What result would materially reverse the current belief?',
    actionTemplate: 'Record the prior, new evidence, updated confidence, and reversal condition.',
    searchTermsText: 'bayesian uncertainty calibration evidence',
    counterLensKey: 'circle-of-competence',
  }),
  mentalModel({
    key: 'ooda-loop',
    name: 'OODA Loop',
    description: 'Defines the fastest safe observation, orientation, decision, action, and feedback cycle.',
    coreQuestion: 'What is the fastest safe observe-orient-decide-act cycle and its feedback signal?',
    evidenceCheckQuestion: 'What signal proves the action improved the situation?',
    actionTemplate: 'Run one bounded cycle with a named observation and stop condition.',
    searchTermsText: 'feedback iteration decision loop',
    counterLensKey: 'second-order-thinking',
  }),
  mentalModel({
    key: 'antifragility',
    name: 'Antifragility',
    description: 'Looks for safe ways that failures can create information, options, and stronger future behavior.',
    coreQuestion: 'Can this failure create information or optionality that makes the system safer next time?',
    evidenceCheckQuestion: 'Does the proposed experiment cap downside while preserving learning?',
    actionTemplate: 'Convert one likely failure into a bounded experiment with reusable evidence.',
    searchTermsText: 'antifragility robustness optionality feedback',
    counterLensKey: 'occams-razor',
  }),
  mentalModel({
    key: 'inversion',
    name: 'Inversion',
    description: 'Starts from guaranteed failure or false completion and removes those conditions.',
    coreQuestion: 'What would guarantee a false completion or failed launch, and how is it removed?',
    evidenceCheckQuestion: 'Which failure condition remains untested?',
    actionTemplate: 'List the three most credible failure conditions and eliminate the highest-impact one.',
    searchTermsText: 'inversion pre-mortem failure mode',
    counterLensKey: 'first-principles-thinking',
  }),
  mentalModel({
    key: 'bottleneck-theory',
    name: 'Bottleneck Theory',
    description: 'Identifies the constraint limiting end-to-end completion instead of optimizing non-constraints.',
    coreQuestion: 'Which single constraint limits end-to-end completion right now?',
    evidenceCheckQuestion: 'What evidence shows this is the current constraint rather than merely visible work?',
    actionTemplate: 'Measure the limiting handoff and improve that constraint before adjacent components.',
    searchTermsText: 'bottleneck constraint throughput',
    counterLensKey: 'second-order-thinking',
  }),
  mentalModel({
    key: 'first-principles-thinking',
    name: 'First-Principles Thinking',
    description: 'Separates measured facts and hard constraints from inherited implementation assumptions.',
    coreQuestion: 'Which facts are hard constraints and which are inherited assumptions?',
    evidenceCheckQuestion: 'Which assumption can be tested directly at lowest cost?',
    actionTemplate: 'Rewrite the decision from verified facts, constraints, and one testable assumption.',
    searchTermsText: 'first principles constraint assumption',
    counterLensKey: 'circle-of-competence',
  }),
  thinkerInspired({
    key: 'taleb-inspired',
    name: 'Taleb-inspired',
    description: 'Examines uncertainty, exposure, optionality, fragility, and asymmetric downside.',
    coreQuestion: 'Where is the asymmetric downside, and how can exposure be reduced while preserving upside?',
    evidenceCheckQuestion: 'Where could a small assumption create an outsized irreversible loss?',
    actionTemplate: 'Reduce the largest exposure and preserve a reversible option before seeking upside.',
    searchTermsText: 'uncertainty fragility optionality downside',
    counterLensKey: 'bayesian-updating',
  }),
  thinkerInspired({
    key: 'carnegie-inspired',
    name: 'Carnegie-inspired',
    description: 'Examines trust, clear communication, stakeholder cooperation, and preserved agency.',
    coreQuestion: "What action preserves trust, clarity, and the other party's agency?",
    evidenceCheckQuestion: "Has the affected party's goal and constraint been represented accurately?",
    actionTemplate: 'State the shared outcome, acknowledge the other constraint, and propose one voluntary next step.',
    searchTermsText: 'trust communication cooperation agency',
    counterLensKey: 'greene-inspired',
  }),
  thinkerInspired({
    key: 'greene-inspired',
    name: 'Greene-inspired',
    description: 'Examines incentives, dependencies, power asymmetry, and unintended strategic signals ethically.',
    coreQuestion: 'Which incentives or dependencies could distort the apparent decision?',
    evidenceCheckQuestion: 'Which dependency or incentive is missing from the stated rationale?',
    actionTemplate: 'Map decision authority, incentives, and dependencies without deception or coercion.',
    searchTermsText: 'incentive dependency governance power',
    counterLensKey: 'carnegie-inspired',
  }),
  thinkerInspired({
    key: 'hormozi-inspired',
    name: 'Hormozi-inspired',
    description: 'Examines concrete user value, friction, leverage, time-to-outcome, and proof.',
    coreQuestion: 'What concrete user outcome improves, and what friction delays that outcome?',
    evidenceCheckQuestion: 'What observable user outcome demonstrates value rather than activity?',
    actionTemplate: 'Name the user outcome, remove one friction point, and define proof of delivery.',
    searchTermsText: 'value friction adoption outcome',
    counterLensKey: 'goodharts-law',
  }),
  thinkerInspired({
    key: 'deming-inspired',
    name: 'Deming-inspired',
    description: 'Examines system quality, variation, feedback loops, and measurable process improvement.',
    coreQuestion: 'Which system condition produces this result, and what feedback proves improvement?',
    evidenceCheckQuestion: 'Which process measure distinguishes common-cause from special-cause variation?',
    actionTemplate: 'Change one system condition and measure the feedback loop before blaming an individual component.',
    searchTermsText: 'system quality variation feedback improvement',
    counterLensKey: 'goodharts-law',
  }),
]);

const KINDS = Object.freeze([...new Set(LENSES.map((lens) => lens.kind))]);

const LENSES_BY_KEY = new Map(LENSES.map((lens) => [lens.key, lens]));

function listLenses(options = {}) {
  const { kind } = options || {};
  if (!kind) return LENSES;
  return LENSES.filter((lens) => lens.kind === kind);
}

function getLens(key) {
  return LENSES_BY_KEY.get(key) || null;
}

module.exports = {
  LENSES,
  KINDS,
  listLenses,
  getLens,
};
