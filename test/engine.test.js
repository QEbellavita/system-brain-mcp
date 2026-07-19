'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBrainService, globToRegExp } = require('../src/engine');

const COMPLETE_HEALTH = { ok: true, complete: true, partial: false, failed: false };

function evidenceHealth(result) {
  return Object.fromEntries(
    ['ok', 'complete', 'partial', 'failed', 'skipped', 'stale', 'reason']
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]])
  );
}

describe('brain service: whereDoesThisDeploy', () => {
  let repoRoot;
  let manifestPath;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-repo-'));
    fs.mkdirSync(path.join(repoRoot, '.git'));
    fs.writeFileSync(path.join(repoRoot, 'vercel.json'), '{}');
    manifestPath = path.join(repoRoot, 'manifest.json');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('glob helper matches ** and * correctly', () => {
    expect(globToRegExp('/Users/x/**/repo/*').test('/Users/x/a/b/repo/file.js')).toBe(true);
    expect(globToRegExp('/Users/x/**/repo/*').test('/Users/x/a/b/repo/nested/file.js')).toBe(false);
    expect(globToRegExp('/Users/x/**').test('/Users/x/a/b/repo/file.js')).toBe(true);
    expect(globToRegExp('/Users/x/*.json').test('/Users/x/manifest.json')).toBe(true);
    expect(globToRegExp('/Users/x/*.json').test('/Users/x/a/manifest.json')).toBe(false);
  });

  test('resolves repo root, matches manifest, and confirms agreement', () => {
    const manifest = {
      repos: [
        {
          match: [`${repoRoot}/**`],
          platform: 'vercel',
          service: 'frontend',
          branch: 'main',
          autoDeploy: true,
          verify: '/health',
          notes: 'test repo',
        },
      ],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const service = createBrainService({ manifestPath, vaults: null });
    const result = service.whereDoesThisDeploy(path.join(repoRoot, 'src', 'index.js'));

    expect(result.repo).toBe(repoRoot);
    expect(result.canonical.platform).toBe('vercel');
    expect(result.detected).toEqual(expect.arrayContaining([{ file: 'vercel.json', platform: 'vercel' }]));
    expect(result.agreement).toBe('confirmed');
    expect(result.confidence).toBe('high');
    expect(typeof result.guidance).toBe('string');
  });

  test('flags conflict when manifest platform disagrees with detected config', () => {
    const manifest = {
      repos: [
        {
          match: [`${repoRoot}/**`],
          platform: 'railway',
          autoDeploy: true,
        },
      ],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const service = createBrainService({ manifestPath, vaults: null });
    const result = service.whereDoesThisDeploy(path.join(repoRoot, 'src', 'index.js'));

    expect(result.agreement).toBe('conflict');
    expect(result.confidence).toBe('low');
    expect(result.guidance).toMatch(/disagree/i);
  });

  test('config-only agreement when no manifest match exists', () => {
    const service = createBrainService({ manifestPath: path.join(repoRoot, 'nope.json'), vaults: null });
    const result = service.whereDoesThisDeploy(repoRoot);

    expect(result.canonical).toBeNull();
    expect(result.agreement).toBe('config-only');
    expect(result.confidence).toBe('medium');
    expect(result.manifestNote).toBeDefined();
  });

  test('unknown agreement when nothing is found and repo is null outside any git repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-outside-'));
    try {
      const service = createBrainService({ manifestPath: path.join(outside, 'nope.json'), vaults: null });
      const result = service.whereDoesThisDeploy(outside);
      expect(result.repo).toBeNull();
      expect(result.agreement).toBe('unknown');
      expect(result.confidence).toBe('low');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('does not throw when manifest JSON is invalid', () => {
    fs.writeFileSync(manifestPath, '{not valid json');
    const service = createBrainService({ manifestPath, vaults: null });
    expect(() => service.whereDoesThisDeploy(repoRoot)).not.toThrow();
    const result = service.whereDoesThisDeploy(repoRoot);
    expect(result.canonical).toBeNull();
    expect(result.manifestNote).toMatch(/invalid/i);
  });
});

describe('brain service: backlog', () => {
  let vaultRoot;

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-vault-'));
  });

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  test('includeVault defaults to false — fast path skips the vault entirely', () => {
    const execImpl = () => ({ stdout: '[]' });
    const service = createBrainService({ manifestPath: null, vaults: { Notes: vaultRoot }, execImpl });
    const result = service.backlog({ repos: ['/repo'] });

    expect(evidenceHealth(result.sources.vault)).toEqual({
      ok: false,
      complete: false,
      partial: false,
      failed: false,
      skipped: true,
      reason: 'includeVault=false',
    });
    expect(result.items.every((item) => item.source !== 'vault')).toBe(true);
  });

  test('aggregates github + git + vault sources and tolerates one failing source', () => {
    fs.writeFileSync(path.join(vaultRoot, 'a.md'), '# A\nBLOCKED on x\n');
    fs.writeFileSync(path.join(vaultRoot, 'b.md'), '# B\nnothing interesting\n');

    const execImpl = (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'pr') {
        return { stdout: JSON.stringify([{ number: 12, title: 'Add feature', headRefName: 'feat/x' }]) };
      }
      if (cmd === 'gh' && args[0] === 'issue') {
        return { stdout: JSON.stringify([{ number: 5, title: 'Bug report' }]) };
      }
      if (cmd === 'git' && args.includes('for-each-ref')) {
        return { stdout: 'feat/ahead [ahead 2]\nfeat/no-upstream\n' };
      }
      if (cmd === 'git' && args.includes('worktree')) {
        return { stdout: 'worktree /repo\nworktree /repo-wt\n' };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    };

    const service = createBrainService({ manifestPath: null, vaults: { Notes: vaultRoot }, execImpl });
    const result = service.backlog({ repos: ['/repo'], includeVault: true, vaultMarkers: ['BLOCKED', 'TODO'] });

    expect(result.sources.github.ok).toBe(true);
    expect(result.sources.git.ok).toBe(true);
    expect(result.sources.vault.ok).toBe(true);
    expect(result.sources.vault.coverage).toMatch(/^scanned \d+ of \d+ notes/);
    expect(result.sources.vault.scanned).toBe(2);
    expect(result.sources.vault.total).toBe(2);

    const githubItems = result.items.filter((item) => item.source === 'github');
    expect(githubItems).toHaveLength(2);

    const gitItems = result.items.filter((item) => item.source === 'git');
    expect(gitItems.some((item) => item.ref === 'feat/ahead')).toBe(true);
    expect(gitItems.some((item) => item.ref === 'feat/no-upstream')).toBe(true);
    expect(gitItems.some((item) => item.ref === 'worktrees')).toBe(true);

    const vaultItems = result.items.filter((item) => item.source === 'vault');
    expect(vaultItems).toHaveLength(1);
    expect(vaultItems[0].location).toBe('a.md');
    expect(vaultItems[0].title).toBe('BLOCKED on x');

    expect(result.counts.total).toBe(result.items.length);
    expect(result.counts.bySource.github).toBe(2);
  });

  test('does not fail the whole call when github source fails', () => {
    const execImpl = (cmd, args) => {
      if (cmd === 'gh') throw new Error('gh: command not found');
      if (cmd === 'git' && args.includes('for-each-ref')) return { stdout: '' };
      if (cmd === 'git' && args.includes('worktree')) return { stdout: 'worktree /repo\n' };
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const service = createBrainService({ manifestPath: null, vaults: null, execImpl });
    const result = service.backlog({ repos: ['/repo'], includeVault: false });

    expect(result.sources.github.ok).toBe(false);
    expect(result.sources.github.reason).toMatch(/command not found/);
    expect(result.sources.git.ok).toBe(true);
    expect(result.sources.vault.coverage).toBe('marker-sample (not exhaustive)');
    expect(result.items.every((item) => item.source !== 'github')).toBe(true);
  });

  test('marks vault source failed when no vaults are configured', () => {
    const execImpl = () => ({ stdout: '[]' });
    const service = createBrainService({ manifestPath: null, vaults: null, execImpl });
    const result = service.backlog({ repos: ['/repo'], includeVault: true });

    expect(result.sources.vault.ok).toBe(false);
    expect(result.sources.vault.reason).toMatch(/no vaults/i);
  });

  test('vault scan reads at most vaultMaxFiles files even for a 500-note synthetic vault', () => {
    const FILE_COUNT = 500;
    const files = new Map();
    for (let i = 0; i < FILE_COUNT; i += 1) {
      const relPath = `note-${i}.md`;
      const content = i === 0 ? '# Note\nBLOCKED: rare marker on file 0\n' : `# Note ${i}\nnothing to see here\n`;
      // Give lower indices the most recent mtime so the guaranteed match is
      // scanned first regardless of the cap.
      files.set(relPath, { content, mtimeMs: FILE_COUNT - i });
    }

    const readCalls = [];
    const root = vaultRoot;
    const fakeFsImpl = {
      realpathSync: (p) => p,
      existsSync: (p) => (p === root ? true : files.has(path.relative(root, p))),
      statSync: (p) => {
        const entry = files.get(path.relative(root, p));
        return { mtimeMs: entry ? entry.mtimeMs : 0 };
      },
      readdirSync: (dir) => {
        if (dir !== root) return [];
        return Array.from(files.keys()).map((name) => ({
          name,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        }));
      },
      readFileSync: (p) => {
        readCalls.push(p);
        const entry = files.get(path.relative(root, p));
        if (!entry) throw new Error(`missing: ${p}`);
        return entry.content;
      },
    };

    const service = createBrainService({
      manifestPath: null,
      vaults: { Notes: root },
      fsImpl: fakeFsImpl,
      execImpl: () => ({ stdout: '[]' }),
    });

    const result = service.backlog({ repos: [], includeVault: true, vaultMaxFiles: 80 });

    expect(readCalls.length).toBeLessThanOrEqual(80);
    expect(result.sources.vault.ok).toBe(true);
    expect(result.sources.vault.coverage).toContain('scanned');
    expect(result.sources.vault.coverage).toContain('80');
    expect(result.sources.vault.total).toBe(FILE_COUNT);
    expect(result.items.some((item) => item.source === 'vault' && item.title.includes('rare marker'))).toBe(true);
  });
});

describe('brain service: fabricationAudit', () => {
  test('finds fabricated confidence/accuracy/score/decision leaves and reports counts', () => {
    const files = new Map([
      [
        '/engines/ppg.js',
        'function score() {\n  return {\n    confidence: 0.8 + Math.random() * 0.2,\n  };\n}\n',
      ],
      [
        '/engines/bridge.js',
        'function isUp() {\n  return Math.random() > 0.1;\n}\n' +
          'function real() {\n  return computeFromInputs(x, y);\n}\n',
      ],
      ['/engines/real.js', 'function fit(data) {\n  return trainModel(data);\n}\n'],
    ]);
    const dirs = new Map([
      [
        '/engines',
        [
          { name: 'ppg.js', isDirectory: () => false, isFile: () => true },
          { name: 'bridge.js', isDirectory: () => false, isFile: () => true },
          { name: 'real.js', isDirectory: () => false, isFile: () => true },
          { name: 'bridge.test.js', isDirectory: () => false, isFile: () => true },
          { name: '__tests__', isDirectory: () => true, isFile: () => false },
        ],
      ],
    ]);
    const fakeFsImpl = {
      existsSync: (p) => p === '/engines' || files.has(p),
      readdirSync: (dir) => dirs.get(dir) || [],
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error(`missing: ${p}`);
        return files.get(p);
      },
    };

    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      fabricationDirs: ['/engines'],
    });

    const result = service.fabricationAudit();

    expect(evidenceHealth(result)).toEqual(COMPLETE_HEALTH);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.byKind).toEqual({ 'fabricated-value': 1, 'fabricated-decision': 1 });
    expect(result.fileCount).toBe(2);
    expect(result.filesScanned).toBe(3);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: '/engines/ppg.js', line: 3, kind: 'fabricated-value' }),
        expect.objectContaining({ file: '/engines/bridge.js', line: 2, kind: 'fabricated-decision' }),
      ])
    );
    expect(result.capped).toBeUndefined();
    const serialized = JSON.parse(JSON.stringify(result));
    expect(evidenceHealth(serialized)).toEqual(COMPLETE_HEALTH);
    expect(serialized.findings).toEqual(result.findings);
  });

  test('is graceful when no directories are configured', () => {
    const service = createBrainService({ manifestPath: null, vaults: null });
    const result = service.fabricationAudit();
    const expectedHealth = {
      ok: false,
      complete: false,
      partial: false,
      failed: true,
      reason: 'No scan directories configured',
    };
    expect(result).toEqual({ ok: false, reason: 'No scan directories configured', findings: [] });
    expect(evidenceHealth(result)).toEqual(expectedHealth);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ findings: [], ...expectedHealth });
  });

  test.each([
    ['missing directory', {
      existsSync: () => false,
      readdirSync: () => [],
      readFileSync: () => '',
    }],
    ['readdir failure', {
      existsSync: () => true,
      readdirSync: () => { throw new Error('EACCES: /private/customer/engines'); },
      readFileSync: () => '',
    }],
  ])('reports failed evidence with non-zero-shaped counts for a configured %s', (_label, fsImpl) => {
    const result = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl,
      fabricationDirs: ['/private/customer/engines'],
    }).fabricationAudit();

    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBeNull();
    expect(result.count).toBeNull();
    expect(result.fileCount).toBeNull();
    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: false,
      failed: true,
      reason: expect.stringMatching(/directory/i),
    });
    expect(result.reason).not.toContain('/private/customer');
    expect(result.reason.length).toBeLessThanOrEqual(200);
    expect(evidenceHealth(JSON.parse(JSON.stringify(result)))).toEqual(evidenceHealth(result));
  });

  test('reports partial evidence when traversal reaches the depth limit', () => {
    const dirs = new Map([
      ['/engines', [{ name: 'one', isDirectory: () => true, isFile: () => false }]],
      ['/engines/one', [{ name: 'two', isDirectory: () => true, isFile: () => false }]],
      ['/engines/one/two', [{ name: 'three', isDirectory: () => true, isFile: () => false }]],
      ['/engines/one/two/three', [{ name: 'four', isDirectory: () => true, isFile: () => false }]],
      ['/engines/one/two/three/four', [{ name: 'five', isDirectory: () => true, isFile: () => false }]],
      ['/engines/one/two/three/four/five', [
        { name: 'hidden.js', isDirectory: () => false, isFile: () => true },
      ]],
    ]);
    const result = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: {
        existsSync: (p) => p === '/engines',
        readdirSync: (dir) => dirs.get(dir) || [],
        readFileSync: () => 'const hidden = { confidence: Math.random() };',
      },
      fabricationDirs: ['/engines'],
    }).fabricationAudit();

    expect(result.count).toBe(0);
    expect(result.findings).toEqual([]);
    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: true,
      failed: false,
      reason: expect.stringMatching(/depth limit/i),
    });
    expect(result.reason).not.toContain('/engines');
  });

  test('reports partial evidence when a JavaScript file cannot be read', () => {
    const result = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: {
        existsSync: (p) => p === '/engines',
        readdirSync: () => [
          { name: 'unreadable.js', isDirectory: () => false, isFile: () => true },
        ],
        readFileSync: () => { throw new Error('EACCES: /private/customer/engines/unreadable.js'); },
      },
      fabricationDirs: ['/engines'],
    }).fabricationAudit();

    expect(result.filesScanned).toBe(0);
    expect(result.count).toBe(0);
    expect(result.findings).toEqual([]);
    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: true,
      failed: false,
      reason: expect.stringMatching(/file read/i),
    });
    expect(result.reason).not.toContain('/private/customer');
    expect(result.reason.length).toBeLessThanOrEqual(200);
  });

  test('per-call dirs override the configured fabricationDirs', () => {
    const files = new Map([['/other/x.js', 'const c = { accuracy: Math.random() * 0.3 + 0.7 };\n']]);
    const fakeFsImpl = {
      existsSync: (p) => p === '/other' || files.has(p),
      readdirSync: (dir) => (dir === '/other' ? [{ name: 'x.js', isDirectory: () => false, isFile: () => true }] : []),
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error(`missing: ${p}`);
        return files.get(p);
      },
    };
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      fabricationDirs: ['/engines'],
    });

    const result = service.fabricationAudit({ dirs: ['/other'] });

    expect(result.count).toBe(1);
    expect(result.findings[0].file).toBe('/other/x.js');
  });

  test('caps findings and reports the cap', () => {
    const lines = [];
    for (let i = 0; i < 350; i += 1) lines.push(`const x${i} = { confidence: Math.random() };`);
    const files = new Map([['/engines/big.js', lines.join('\n')]]);
    const fakeFsImpl = {
      existsSync: (p) => p === '/engines' || files.has(p),
      readdirSync: (dir) => (dir === '/engines' ? [{ name: 'big.js', isDirectory: () => false, isFile: () => true }] : []),
      readFileSync: (p) => files.get(p),
    };
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      fabricationDirs: ['/engines'],
    });

    const result = service.fabricationAudit();

    expect(result.count).toBe(300);
    expect(result.capped).toMatch(/Capped at/);
    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: true,
      failed: false,
      reason: expect.stringMatching(/scan limit/i),
    });
  });
});

function makeFakeSqliteExec({ tables = [], columns = [], indexes = [], rowCount = 0, latest = '2026-01-01' } = {}) {
  return (cmd, args) => {
    expect(cmd).toBe('sqlite3');
    expect(args[0]).toBe('-readonly');
    expect(args[1]).toBe('-json');
    const sql = args[3];
    if (/sqlite_master/.test(sql)) {
      return { stdout: JSON.stringify(tables.map((name) => ({ name }))) };
    }
    if (/PRAGMA table_info/.test(sql)) {
      return { stdout: JSON.stringify(columns) };
    }
    if (/PRAGMA index_list/.test(sql)) {
      return { stdout: JSON.stringify(indexes.map((name) => ({ name }))) };
    }
    if (/MAX\(/.test(sql)) {
      return { stdout: JSON.stringify([{ latest }]) };
    }
    if (/count\(\*\)/.test(sql)) {
      return { stdout: JSON.stringify([{ n: rowCount }]) };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

describe('brain service: dbSchema', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-db-')), 'brain.db');
    fs.writeFileSync(dbPath, '');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('lists tables when no table is given', () => {
    const execImpl = makeFakeSqliteExec({ tables: ['feedback', 'predictions'] });
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });

    const result = service.dbSchema();

    expect(result).toEqual({
      dbBasename: 'brain.db',
      tableCount: 2,
      tables: ['feedback', 'predictions'],
      ...COMPLETE_HEALTH,
    });
  });

  test('returns columns, indexes, and row count for a known table', () => {
    const execImpl = makeFakeSqliteExec({
      tables: ['feedback'],
      columns: [
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'created_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ],
      indexes: ['idx_feedback_created_at'],
      rowCount: 42,
    });
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });

    const result = service.dbSchema('feedback');

    expect(result).toEqual({
      dbBasename: 'brain.db',
      table: 'feedback',
      columns: [
        { name: 'id', type: 'INTEGER', notnull: false, pk: true },
        { name: 'created_at', type: 'TEXT', notnull: false, pk: false },
      ],
      indexes: ['idx_feedback_created_at'],
      rowCount: 42,
      ...COMPLETE_HEALTH,
    });
  });

  test('rejects a table name that is not a bare identifier without ever calling execImpl', () => {
    const execImpl = jest.fn(() => {
      throw new Error('execImpl should not be called for an invalid identifier');
    });
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });

    const result = service.dbSchema('a; drop table feedback;');

    expect(result).toEqual({ error: 'unknown table' });
    expect(execImpl).not.toHaveBeenCalled();
  });

  test('rejects a table name that is a valid identifier but does not exist', () => {
    const execImpl = makeFakeSqliteExec({ tables: ['feedback'] });
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });

    const result = service.dbSchema('nope');

    expect(result).toEqual({ error: 'unknown table' });
  });

  test('is graceful when dbPath is unset', () => {
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath: null });

    const expectedHealth = {
      ok: false,
      complete: false,
      partial: false,
      failed: true,
      reason: 'No database configured',
    };
    expect(service.dbSchema()).toEqual({ dbBasename: null, ok: false, reason: 'No database configured' });
    expect(service.dbSchema('feedback')).toEqual({ dbBasename: null, ok: false, reason: 'No database configured' });
    expect(evidenceHealth(service.dbSchema())).toEqual(expectedHealth);
    expect(JSON.parse(JSON.stringify(service.dbSchema()))).toEqual({ dbBasename: null, ...expectedHealth });
  });

  test('is graceful when the database file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'brain-test-missing-db.db');
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath: missingPath });

    const result = service.dbSchema();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });
});

describe('brain service: mlModels', () => {
  test('modelsDirs=[] is skipped non-complete evidence, never a healthy empty scan', () => {
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      modelsDirs: [],
    });

    const result = service.mlModels();

    expect(result.count).toBe(0);
    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: false,
      failed: false,
      skipped: true,
      reason: 'No model directories configured',
    });
  });

  test('lists artifacts by extension, computes byType, and reports registry availability', () => {
    const files = new Map([
      ['/models/attnres.onnx', { size: 100, mtimeMs: 1000 }],
      ['/models/nested/goemotions.pkl', { size: 200, mtimeMs: 2000 }],
      ['/models/readme.txt', { size: 10, mtimeMs: 3000 }],
    ]);
    const dirs = new Map([
      ['/models', [
        { name: 'attnres.onnx', isDirectory: () => false, isFile: () => true },
        { name: 'nested', isDirectory: () => true, isFile: () => false },
        { name: 'readme.txt', isDirectory: () => false, isFile: () => true },
      ]],
      ['/models/nested', [
        { name: 'goemotions.pkl', isDirectory: () => false, isFile: () => true },
      ]],
    ]);
    const fakeFsImpl = {
      existsSync: (p) => p === '/models' || files.has(p),
      readdirSync: (dir) => dirs.get(dir) || [],
      statSync: (p) => {
        const entry = files.get(p);
        if (!entry) throw new Error(`missing: ${p}`);
        return { size: entry.size, mtimeMs: entry.mtimeMs };
      },
    };

    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      modelsDirs: ['/models'],
      registryDoc: '/registry/SKILL.md',
    });

    const result = service.mlModels();

    expect(evidenceHealth(result)).toEqual(COMPLETE_HEALTH);
    expect(result.count).toBe(2);
    expect(result.byType).toEqual({ onnx: 1, pkl: 1 });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'attnres.onnx', dir: 'models', type: 'onnx', sizeBytes: 100 }),
        expect.objectContaining({ name: 'goemotions.pkl', dir: 'nested', type: 'pkl', sizeBytes: 200 }),
      ])
    );
    expect(result.registryAvailable).toBe(false);
    expect(result.note).toMatch(/does NOT mean a model is loaded or active/);
    expect(result.capped).toBeUndefined();
  });

  test('caps artifacts at 200 and notes it was capped', () => {
    const entries = [];
    const files = new Map();
    for (let i = 0; i < 250; i += 1) {
      const name = `model-${i}.onnx`;
      entries.push({ name, isDirectory: () => false, isFile: () => true });
      files.set(`/models/${name}`, { size: 1, mtimeMs: i });
    }
    const fakeFsImpl = {
      existsSync: (p) => p === '/models',
      readdirSync: (dir) => (dir === '/models' ? entries : []),
      statSync: (p) => {
        const entry = files.get(p);
        if (!entry) throw new Error(`missing: ${p}`);
        return { size: entry.size, mtimeMs: entry.mtimeMs };
      },
    };

    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      modelsDirs: ['/models'],
      registryDoc: null,
    });

    const result = service.mlModels();

    expect(result.count).toBe(200);
    expect(result.capped).toBeDefined();
    expect(evidenceHealth(result)).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      partial: true,
      failed: false,
    }));
  });

  test('reports registryAvailable true when the registry doc exists', () => {
    const fakeFsImpl = {
      existsSync: (p) => p === '/registry/SKILL.md',
      readdirSync: () => [],
      statSync: () => {
        throw new Error('not reached');
      },
    };
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: fakeFsImpl,
      modelsDirs: [],
      registryDoc: '/registry/SKILL.md',
    });

    expect(service.mlModels().registryAvailable).toBe(true);
    expect(service.mlModels().count).toBe(0);
  });

  test.each([
    ['missing directory', {
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ size: 1, mtimeMs: 1 }),
    }],
    ['directory read failure', {
      existsSync: () => true,
      readdirSync: () => { throw new Error('model directory unreadable'); },
      statSync: () => ({ size: 1, mtimeMs: 1 }),
    }],
  ])('reports a failed, non-zero-shaped model result for %s', (_label, fsImpl) => {
    const result = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl,
      modelsDirs: ['/models'],
    }).mlModels();

    expect(result.count).toBeNull();
    expect(evidenceHealth(result)).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      partial: false,
      failed: true,
      reason: expect.any(String),
    }));
  });

  test('reports partial model evidence when an artifact stat fails', () => {
    const fsImpl = {
      existsSync: (p) => p === '/models',
      readdirSync: () => [
        { name: 'good.onnx', isDirectory: () => false, isFile: () => true },
        { name: 'unreadable.onnx', isDirectory: () => false, isFile: () => true },
      ],
      statSync: (p) => {
        if (p.endsWith('unreadable.onnx')) throw new Error('model stat denied');
        return { size: 10, mtimeMs: 1000 };
      },
    };

    const result = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl,
      modelsDirs: ['/models'],
    }).mlModels();

    expect(result.count).toBe(1);
    expect(evidenceHealth(result)).toEqual(expect.objectContaining({
      ok: false,
      complete: false,
      partial: true,
      failed: false,
      reason: expect.stringMatching(/stat/i),
    }));
  });
});

describe('brain service: analytics', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-analytics-')), 'brain.db');
    fs.writeFileSync(dbPath, '');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  // Builds an execImpl that answers sqlite_master, PRAGMA table_info, count(*),
  // the labeled-outcome ledger count, MAX(...), and `SELECT user_id AS uid FROM
  // <t> LIMIT 1` queries from simple per-table fixtures:
  //   { tableName: { rows, columns, latest, sampleUser, labeled } }
  // `labeled` applies only to the prediction_outcomes ledger table.
  function makeAnalyticsExecImpl(fixtures) {
    const execCalls = [];
    const execImpl = (cmd, args) => {
      const sql = args[3];
      execCalls.push(sql);
      if (/sqlite_master/.test(sql)) {
        return { stdout: JSON.stringify(Object.keys(fixtures).map((name) => ({ name }))) };
      }
      const pragmaMatch = sql.match(/PRAGMA table_info\((\w+)\)/);
      if (pragmaMatch) {
        const fixture = fixtures[pragmaMatch[1]] || {};
        const columns = fixture.columns || [];
        return {
          stdout: JSON.stringify(
            columns.map((name, cid) => ({ cid, name, type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }))
          ),
        };
      }
      const maxMatch = sql.match(/MAX\((\w+)\) AS latest FROM (\w+)/);
      if (maxMatch) {
        const fixture = fixtures[maxMatch[2]] || {};
        return { stdout: JSON.stringify([{ latest: fixture.latest || null }]) };
      }
      const userMatch = sql.match(/SELECT user_id AS uid FROM (\w+) LIMIT 1/);
      if (userMatch) {
        const fixture = fixtures[userMatch[1]] || {};
        return { stdout: fixture.sampleUser ? JSON.stringify([{ uid: fixture.sampleUser }]) : '' };
      }
      // The labeled-outcome ledger query must be matched BEFORE the generic
      // count(*) — it is a strict subset (`... WHERE actual_outcome IS NOT NULL`).
      const labeledMatch = sql.match(/count\(\*\) AS n FROM (\w+) WHERE actual_outcome IS NOT NULL/);
      if (labeledMatch) {
        const fixture = fixtures[labeledMatch[1]] || {};
        return { stdout: JSON.stringify([{ n: fixture.labeled || 0 }]) };
      }
      const countMatch = sql.match(/count\(\*\) AS n FROM (\w+)/);
      if (countMatch) {
        const fixture = fixtures[countMatch[1]] || {};
        return { stdout: JSON.stringify([{ n: fixture.rows || 0 }]) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
    return { execImpl, execCalls };
  }

  test('feedback-famine: outcome ledger has rows but almost none are labeled', () => {
    const { execImpl, execCalls } = makeAnalyticsExecImpl({
      prediction_outcomes: { rows: 200, labeled: 1, columns: ['created_at'], latest: '2026-06-05', sampleUser: 'user_42' },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.dbBasename).toBe('brain.db');
    expect(evidenceHealth(result)).toEqual(COMPLETE_HEALTH);
    expect(result.source).toMatch(/local development database — NOT production/);
    // Coverage is measured WITHIN the outcome ledger: labeled / total.
    expect(result.predictionRows).toBe(200);
    expect(result.feedbackRows).toBe(1);
    expect(result.feedbackCoverage).toBeCloseTo(0.005);
    expect(result.outcomeLedger).toEqual({ total: 200, labeled: 1, coverage: expect.closeTo(0.005) });
    expect(result.status).toBe('feedback-famine');
    expect(result.famineFlag).toBe(true);
    expect(result.summary).toMatch(/feedback loop is not closing/i);

    // The honest metric MUST read the outcome ledger's labeled subset.
    expect(execCalls.some((sql) => /prediction_outcomes WHERE actual_outcome IS NOT NULL/.test(sql))).toBe(true);
  });

  test('NOT a famine: one real labeled outcome amid seed prediction logs (regression)', () => {
    // The exact real-data shape that produced the false "0.0% coverage" alarm:
    // 660 seed physiol prediction logs (demo user) + a single, fully-labeled
    // outcome-ledger row. Closed-loop coverage is 100%, not 0%. The raw
    // prediction logs are context, never a coverage denominator.
    const { execImpl, execCalls } = makeAnalyticsExecImpl({
      model_prediction_log: { rows: 660, columns: ['created_at'], latest: '2026-06-05', sampleUser: 'demo_ava' },
      feedback: { rows: 0, columns: ['created_at'] },
      prediction_feedback: { rows: 0, columns: [] },
      prediction_outcomes: { rows: 1, labeled: 1, columns: ['created_at'], latest: '2026-05-24' },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.status).toBe('ok');
    expect(result.famineFlag).toBe(false);
    expect(result.feedbackCoverage).toBe(1);
    expect(result.outcomeLedger).toEqual({ total: 1, labeled: 1, coverage: 1 });
    expect(result.predictionActivityRows).toBe(660);
    expect(result.legacyFeedbackRows).toBe(0);
    // Seed data is still honestly flagged even though the loop is not starved.
    expect(result.seedSuspected).toBe(true);
    expect(result.note).toContain('demo_ava');
    expect(execCalls.some((sql) => /prediction_outcomes WHERE actual_outcome IS NOT NULL/.test(sql))).toBe(true);
  });

  test('no-activity: zero predictions and zero feedback', () => {
    const { execImpl } = makeAnalyticsExecImpl({
      feedback: { rows: 0, columns: [] },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.predictionRows).toBe(0);
    expect(result.feedbackRows).toBe(0);
    expect(result.status).toBe('no-activity');
    expect(result.famineFlag).toBe(false);
    expect(result.summary).toMatch(/no prediction or feedback activity/i);
    expect(result.seedSuspected).toBe(false);
  });

  test('feedback-warming: low coverage but too few ledger rows to call famine', () => {
    // 3 outcomes, none labeled — technically 0% coverage, but N is far below the
    // 20-row floor. Report "warming up" (visible), never the alarmist famine.
    const { execImpl } = makeAnalyticsExecImpl({
      prediction_outcomes: { rows: 3, labeled: 0, columns: [] },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.status).toBe('feedback-warming');
    expect(result.famineFlag).toBe(false);
    expect(result.predictionRows).toBe(3);
    expect(result.feedbackRows).toBe(0);
    expect(result.summary).toMatch(/warming up/i);
    expect(result.summary).not.toMatch(/feedback loop is not closing/i);
  });

  test('ok: outcome ledger coverage at/above the famine threshold', () => {
    const { execImpl } = makeAnalyticsExecImpl({
      prediction_outcomes: { rows: 100, labeled: 10, columns: [], sampleUser: 'user_42' },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.predictionRows).toBe(100);
    expect(result.feedbackRows).toBe(10);
    expect(result.feedbackCoverage).toBeCloseTo(0.1);
    expect(result.status).toBe('ok');
    expect(result.famineFlag).toBe(false);
    expect(result.summary).toMatch(/feedback coverage/i);
    expect(result.seedSuspected).toBe(false);
    expect(result.note).toBeUndefined();
  });

  test('no-outcome-ledger: prediction logs exist but nothing entered the ledger', () => {
    // Honest neutral state — NOT a famine alarm. Coverage is unmeasurable
    // because no prediction has created an outcome-ledger row yet.
    const { execImpl } = makeAnalyticsExecImpl({
      predictions: { rows: 100, columns: [], sampleUser: 'user_42' },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.status).toBe('no-outcome-ledger');
    expect(result.famineFlag).toBe(false);
    expect(result.predictionActivityRows).toBe(100);
    expect(result.outcomeLedger).toEqual({ total: 0, labeled: 0, coverage: 0 });
    expect(result.summary).not.toMatch(/feedback loop is not closing/i);
  });

  test('coverage can never exceed 100% even with extra legacy feedback rows', () => {
    const { execImpl } = makeAnalyticsExecImpl({
      prediction_outcomes: { rows: 5, labeled: 5, columns: [] },
      feedback: { rows: 3, columns: [] },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.feedbackCoverage).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.famineFlag).toBe(false);
    expect(result.legacyFeedbackRows).toBe(3);
  });

  test('seedSuspected is false when the sampled prediction user is not a seed user', () => {
    const { execImpl } = makeAnalyticsExecImpl({
      model_prediction_log: { rows: 50, columns: [], sampleUser: 'user_9f3a' },
      prediction_outcomes: { rows: 10, labeled: 5, columns: [] },
    });

    const service = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl });
    const result = service.analytics();

    expect(result.seedSuspected).toBe(false);
    expect(result.note).toBeUndefined();
  });

  test('is graceful when dbPath is unset', () => {
    const service = createBrainService({ manifestPath: null, vaults: null, dbPath: null });
    const result = service.analytics();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('No database configured');
    expect(result.source).toMatch(/local development database/);
  });

  test.each([
    ['table query', /sqlite_master/, { partial: false, failed: true }],
    ['ledger total query', /count\(\*\) AS n FROM prediction_outcomes$/, { partial: true, failed: false }],
    ['ledger labeled query', /prediction_outcomes WHERE actual_outcome IS NOT NULL/, { partial: true, failed: false }],
    ['column query', /PRAGMA table_info\(prediction_outcomes\)/, { partial: true, failed: false }],
  ])('%s failure is explicit and never becomes healthy zero/empty analytics', (_label, failurePattern, expected) => {
    const { execImpl: successfulExec } = makeAnalyticsExecImpl({
      model_prediction_log: { rows: 660, columns: ['created_at'], latest: '2026-06-05', sampleUser: 'user_42' },
      prediction_outcomes: { rows: 200, labeled: 1, columns: ['created_at'], latest: '2026-06-05' },
    });
    const execImpl = (cmd, args) => {
      if (failurePattern.test(args[3])) throw new Error(`${_label} unavailable`);
      return successfulExec(cmd, args);
    };

    const result = createBrainService({ manifestPath: null, vaults: null, dbPath, execImpl }).analytics();

    expect(evidenceHealth(result)).toEqual({
      ok: false,
      complete: false,
      partial: expected.partial,
      failed: expected.failed,
      reason: expect.stringContaining('unavailable'),
    });
    expect(result.status).not.toBe('no-activity');
    expect(result.status).not.toBe('feedback-famine');
    // A failed ledger count must fail-closed to null, never a healthy zero.
    if (_label === 'ledger total query' || _label === 'ledger labeled query') {
      expect(result.feedbackRows).toBeNull();
    }
  });
});

describe('brain service: architecture', () => {
  function makeFakeFsImpl(files) {
    return {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => {
        const entry = files.get(p);
        if (entry === undefined) throw new Error(`missing: ${p}`);
        return entry;
      },
    };
  }

  test('no area: lists doc names (from H1), sections (from H2), and sizeBytes', () => {
    const gatewayContent = '# Engine Gateway\n\n## Emotion Engines\n\n## Biometric Engines\n\nBody text.\n';
    const schemaContent = '# Database Schema\n\n## Tables\n\nBody text.\n';
    const files = new Map([
      ['/skills/engine-gateway/SKILL.md', gatewayContent],
      ['/skills/database-schema/SKILL.md', schemaContent],
    ]);
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: makeFakeFsImpl(files),
      archDocs: ['/skills/engine-gateway/SKILL.md', '/skills/database-schema/SKILL.md'],
    });

    const result = service.architecture();

    expect(result.source).toMatch(/Curated architecture docs/);
    expect(result.docs).toEqual([
      { name: 'Engine Gateway', sections: ['Emotion Engines', 'Biometric Engines'], sizeBytes: gatewayContent.length },
      { name: 'Database Schema', sections: ['Tables'], sizeBytes: schemaContent.length },
    ]);
    // No absolute paths leaked.
    expect(JSON.stringify(result)).not.toContain('/skills/');
  });

  test('no area: falls back to basename when a doc has no H1', () => {
    const content = 'No heading here, just text.\n';
    const files = new Map([['/skills/no-h1/SKILL.md', content]]);
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: makeFakeFsImpl(files),
      archDocs: ['/skills/no-h1/SKILL.md'],
    });

    const result = service.architecture();

    expect(result.docs).toEqual([{ name: 'SKILL.md', sections: [], sizeBytes: content.length }]);
  });

  test('area match returns truncated content with matchedOn and name', () => {
    const longBody = 'x'.repeat(9000);
    const dbContent = `# Database Schema\n\n## Tables\n\n${longBody}`;
    const files = new Map([
      ['/skills/database-schema/SKILL.md', dbContent],
      ['/skills/engine-gateway/SKILL.md', '# Engine Gateway\n\nshort\n'],
    ]);
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: makeFakeFsImpl(files),
      archDocs: ['/skills/database-schema/SKILL.md', '/skills/engine-gateway/SKILL.md'],
    });

    const result = service.architecture('database');

    expect(result.name).toBe('Database Schema');
    expect(result.matchedOn).toBe('Database Schema');
    expect(result.content.length).toBe(8000 + '\n\n[...truncated...]'.length);
    expect(result.content.startsWith('# Database Schema')).toBe(true);
    expect(result.content).not.toContain('/skills/');
  });

  test('area no-match returns error with available doc names', () => {
    const files = new Map([['/skills/engine-gateway/SKILL.md', '# Engine Gateway\n\nbody\n']]);
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: makeFakeFsImpl(files),
      archDocs: ['/skills/engine-gateway/SKILL.md'],
    });

    const result = service.architecture('nonexistent-area');

    expect(result).toEqual({ error: 'no architecture doc matches', available: ['Engine Gateway'] });
  });

  test('empty archDocs is graceful for both no-area and area calls', () => {
    const service = createBrainService({ manifestPath: null, vaults: null, archDocs: [] });

    expect(service.architecture()).toEqual({
      source: expect.stringMatching(/Curated architecture docs/),
      docs: [],
    });
    expect(service.architecture('database')).toEqual({ error: 'no architecture docs configured' });
  });

  test('skips archDocs that do not exist on disk', () => {
    const files = new Map([['/skills/exists/SKILL.md', '# Exists\n\nbody\n']]);
    const service = createBrainService({
      manifestPath: null,
      vaults: null,
      fsImpl: makeFakeFsImpl(files),
      archDocs: ['/skills/exists/SKILL.md', '/skills/missing/SKILL.md'],
    });

    const result = service.architecture();
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].name).toBe('Exists');
  });
});
