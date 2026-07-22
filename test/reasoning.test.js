'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBrainService, buildRecommendations } = require('../src/engine');

const COMPLETE = { ok: true, complete: true, partial: false, failed: false };
const FAILED = { ok: false, complete: false, partial: false, failed: true };

function famineAnalytics(overrides = {}) {
  return {
    ...COMPLETE,
    status: 'feedback-famine',
    predictionRows: 500,
    feedbackRows: 3,
    feedbackCoverage: 0.006,
    ...overrides,
  };
}

describe('buildRecommendations', () => {
  test('feedback famine yields close-the-feedback-loop as a high-priority candidate', () => {
    const recs = buildRecommendations({ analytics: famineAnalytics() });
    const rec = recs.find((r) => r.key === 'close-the-feedback-loop');
    expect(rec).toBeDefined();
    expect(rec.priority).toBe('high');
    expect(rec.why).toContain('500');
    expect(rec.evidence).toBe('brain_analytics');
    expect(rec.category).toBe('integration-gap');
    expect(rec.evidenceSources).toEqual(['analytics']);
  });

  test('models on disk during a famine adds models-present-but-not-learning', () => {
    const recs = buildRecommendations({
      analytics: famineAnalytics(),
      models: { ...COMPLETE, count: 4 },
    });
    expect(recs.map((r) => r.key)).toContain('models-present-but-not-learning');
  });

  test('incomplete evidence emits nothing — degraded sources never become recommendations', () => {
    const recs = buildRecommendations({
      analytics: { ...FAILED, status: 'feedback-famine', predictionRows: 500, feedbackRows: 0, feedbackCoverage: 0 },
      models: { ...FAILED, count: 9 },
    });
    expect(recs).toEqual([]);
  });

  test('no-outcome-ledger stays quiet below the activity floor', () => {
    const recs = buildRecommendations({
      analytics: { ...COMPLETE, status: 'no-outcome-ledger', predictionActivityRows: 2 },
    });
    expect(recs).toEqual([]);
  });

  test('github and git backlog counts surface with their priorities, ranked', () => {
    const recs = buildRecommendations({
      analytics: famineAnalytics(),
      backlog: {
        sources: { github: { ...COMPLETE }, git: { ...COMPLETE } },
        counts: { bySource: { github: 7, git: 2 } },
      },
    });
    const keys = recs.map((r) => r.key);
    expect(keys).toContain('open-github-items-to-triage');
    expect(keys).toContain('local-git-branches-unpushed-unmerged');
    const priorities = recs.map((r) => ({ high: 0, medium: 1, low: 2 }[r.priority]));
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  test('roadmap notes surface the note with the most open items', () => {
    const recs = buildRecommendations({
      roadmap: {
        ...COMPLETE,
        notes: [
          { title: 'Small plan', openItems: 1 },
          { title: 'Big plan', openItems: 9 },
        ],
      },
    });
    const rec = recs.find((r) => r.key === 'roadmap-open-items');
    expect(rec.title).toContain('Big plan');
    expect(rec.title).toContain('9');
  });

  test('systems/phases come from taxonomy classification, not a baked-in ontology', () => {
    const recs = buildRecommendations({ analytics: famineAnalytics() });
    const rec = recs.find((r) => r.key === 'close-the-feedback-loop');
    expect(Array.isArray(rec.systems)).toBe(true);
    expect(Array.isArray(rec.phases)).toBe(true);
  });

  test('no signals, no recommendations', () => {
    expect(buildRecommendations({})).toEqual([]);
  });
});

describe('brain service: roadmap', () => {
  function makeVault(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-roadmap-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  test('no vaults configured is a failed result, not a healthy empty scan', () => {
    const service = createBrainService({ manifestPath: null, vaults: null });
    const result = service.roadmap();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no vaults configured');
    expect(JSON.parse(JSON.stringify(result)).failed).toBe(true);
  });

  test('counts open checklist items in filename-matched notes only', () => {
    const root = makeVault({
      'Roadmap Q3.md': '# Q3 Roadmap\n\n- [ ] ship it\n- [x] done thing\n- [ ] test it\n',
      'groceries.md': '- [ ] milk\n',
    });
    const service = createBrainService({ manifestPath: null, vaults: { Test: root } });
    const result = service.roadmap();
    expect(result.complete).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ title: 'Q3 Roadmap', openItems: 2 });
    expect(result.notes[0].sampleOpen).toEqual(['- [ ] ship it', '- [ ] test it']);
  });

  test('content reads are bounded by limit and the shortfall is reported as partial', () => {
    const files = {};
    for (let i = 0; i < 5; i += 1) files[`plan-${i}.md`] = `# Plan ${i}\n- [ ] item\n`;
    const root = makeVault(files);
    const service = createBrainService({ manifestPath: null, vaults: { Test: root } });
    const result = service.roadmap({ limit: 2 });
    expect(result.matched).toBe(5);
    expect(result.read).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.reason).toContain('limit 2');
  });

  test('a note without an H1 falls back to its basename', () => {
    const root = makeVault({ 'next-steps.md': '- [ ] first thing\n' });
    const service = createBrainService({ manifestPath: null, vaults: { Test: root } });
    expect(service.roadmap().notes[0].title).toBe('next-steps.md');
  });
});

describe('brain service: recommend', () => {
  function bareService() {
    // No db, no models dirs, exec that fails: every source degrades honestly.
    return createBrainService({
      manifestPath: null,
      vaults: null,
      dbPath: null,
      modelsDirs: [],
      execImpl: () => { throw new Error('exec unavailable in test'); },
    });
  }

  test('reports per-source health and labels itself as a rule table, not a model', async () => {
    const result = await bareService().recommend();
    expect(result.source).toContain('NOT a predictive/AI model');
    expect(Object.keys(result.sourceHealth).sort()).toEqual(
      ['analytics', 'git', 'github', 'models', 'roadmap'].sort()
    );
    expect(result.sourceHealth.roadmap.skipped).toBe(true);
    expect(result.sourceHealth.roadmap.reason).toBe('deep=false');
  });

  test('degraded everything yields zero recommendations and says so', async () => {
    const result = await bareService().recommend();
    expect(result.recommendations).toEqual([]);
    expect(result.note).toBe('No actionable signals from current data.');
  });

  test('ships a reasoning contract naming candidates and degraded sources', async () => {
    const result = await bareService().recommend();
    expect(result.reasoning.audience).toBe('calling-model');
    expect(result.reasoning.candidateKeys).toEqual([]);
    expect(result.reasoning.degradedSources).toEqual(
      expect.arrayContaining(['analytics'])
    );
    expect(result.reasoning.degradedSources).not.toContain('roadmap');
  });

  test('deep=true engages the roadmap scan instead of skipping it', async () => {
    const result = await bareService().recommend({ deep: true });
    expect(result.sourceHealth.roadmap.skipped).not.toBe(true);
    expect(result.sourceHealth.roadmap.failed).toBe(true);
    expect(result.sourceHealth.roadmap.reason).toBe('no vaults configured');
  });
});

describe('tools: reframe input validation and capabilities', () => {
  const toolsModule = require('../src/tools');

  test('free-string repository in taskContext validates instead of throwing (REPOSITORY_ENUM regression)', () => {
    expect(toolsModule.validateReframeInput({ taskContext: { repository: 'any-repo-name' } })).toEqual({ ok: true });
    expect(toolsModule.validateReframeInput({ taskContext: { repository: '' } }).ok).toBe(false);
    expect(toolsModule.validateReframeInput({ taskContext: { repository: 'x'.repeat(81) } }).ok).toBe(false);
  });

  test('unknown keys and empty input are rejected', () => {
    expect(toolsModule.validateReframeInput({}).ok).toBe(false);
    expect(toolsModule.validateReframeInput({ nonsense: true }).ok).toBe(false);
  });

  test('capabilities resource resolves and reports no knowledge base (kbPath regression)', async () => {
    const resource = toolsModule.resources()[0];
    const capabilities = await resource.handler();
    expect(capabilities.kbConfigured).toBe(false);
    expect(capabilities.tools).toEqual(
      expect.arrayContaining(['brain_roadmap', 'brain_recommend', 'brain_reframe'])
    );
    expect(capabilities.tools).toHaveLength(11);
  });

  test('brain_reframe with a task-only subject returns a packet that fails toward uncertainty', async () => {
    const reframe = toolsModule.tools().find((t) => t.def.name === 'brain_reframe');
    const packet = await reframe.handler({ taskContext: { workTypes: ['verification'] } });
    expect(packet.lensAnalysis).toBeDefined();
    expect(packet.reasoning.audience).toBe('calling-model');
    expect(packet.kbEvidence).toEqual({ concepts: [], links: [], articles: [], sources: [] });
    // No KB in this build: evidence health must gate non-complete, which
    // trips the adversarial review rather than reading as confirmed support.
    expect(packet.evidenceHealth.complete).not.toBe(true);
    expect(packet.adversarialReview.applied).toBe(true);
    expect(packet.adversarialReview.triggers).toContain('evidence-uncertain');
  });

  test('brain_reframe rejects an unknown recommendation key with a bounded error', async () => {
    const reframe = toolsModule.tools().find((t) => t.def.name === 'brain_reframe');
    const result = await reframe.handler({ recommendationKey: 'not-a-real-key' });
    expect(result).toEqual({ ok: false, error: 'recommendation not found' });
  });
});
