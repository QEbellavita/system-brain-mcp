'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildReasoningContract } = require('./contract');

const CONFIG_FILE_PLATFORMS = {
  'railway.json': 'railway',
  'railway.toml': 'railway',
  'nixpacks.toml': 'railway',
  Procfile: 'heroku',
  'vercel.json': 'vercel',
  'fly.toml': 'fly',
  'netlify.toml': 'netlify',
  'render.yaml': 'render',
  Dockerfile: 'docker',
};

const WORKFLOW_PLATFORM_KEYWORDS = [
  { keyword: 'railway', platform: 'railway' },
  { keyword: 'vercel', platform: 'vercel' },
  { keyword: 'fly', platform: 'fly' },
  { keyword: 'render', platform: 'render' },
  { keyword: 'deploy', platform: null },
];

const DEFAULT_VAULT_MARKERS = ['BLOCKED', 'next step', 'TODO', 'follow-up', '- [ ]'];

const MODEL_EXTENSIONS = new Set(['onnx', 'pkl', 'mlmodel', 'coreml', 'tflite', 'pt', 'h5', 'json']);
const MODEL_ARTIFACT_CAP = 200;
const MODEL_MAX_DEPTH = 2;

// The genuine closed-loop signal lives in the outcome ledger: prediction_outcomes
// holds one row per prediction that entered the feedback loop, with actual_outcome
// Analytics + fabrication constants come from config/analytics.json (falling
// back to analytics.default.json) so they describe YOUR schema, not a baked-in
// one. See that file for what each knob means.
const ANALYTICS_CFG = require('./analytics-config').load();
const ANALYTICS_OUTCOME_LEDGER_TABLE = ANALYTICS_CFG.outcomeLedger.table;
const ANALYTICS_OUTCOME_LABEL_COLUMN = ANALYTICS_CFG.outcomeLedger.labelColumn;
const ANALYTICS_LEGACY_FEEDBACK_TABLES = ANALYTICS_CFG.legacyFeedbackTables;
const ANALYTICS_PREDICTION_TABLES = ANALYTICS_CFG.predictionTables;
const ANALYTICS_TABLES = [
  ...ANALYTICS_LEGACY_FEEDBACK_TABLES,
  ...ANALYTICS_PREDICTION_TABLES,
  ANALYTICS_OUTCOME_LEDGER_TABLE,
];
const ANALYTICS_TIMESTAMP_COLUMNS = ANALYTICS_CFG.timestampColumns;
const FEEDBACK_COVERAGE_FAMINE_THRESHOLD = ANALYTICS_CFG.thresholds.famineCoverageRatio;
const FEEDBACK_LEDGER_MIN_FAMINE = ANALYTICS_CFG.thresholds.ledgerMinForFamine;
const NO_LEDGER_ACTIVITY_FLOOR = ANALYTICS_CFG.thresholds.noLedgerActivityFloor;
const SEED_USER_PATTERN = ANALYTICS_CFG.seedUserPattern;

const FABRICATION_MAX_DEPTH = ANALYTICS_CFG.fabrication.maxDepth;
const FABRICATION_FILE_CAP = ANALYTICS_CFG.fabrication.fileCap;
const FABRICATION_FINDING_CAP = ANALYTICS_CFG.fabrication.findingCap;
const FABRICATION_EXTENSIONS = ANALYTICS_CFG.fabrication.extensions;
const FABRICATION_EXCLUDE_DIR_PATTERN = ANALYTICS_CFG.fabrication.excludeDirPattern;
const FABRICATION_EXCLUDE_FILE_PATTERN = ANALYTICS_CFG.fabrication.excludeFilePattern;
// Tight, validated patterns only — a naive `Math.random()` grep across this codebase
// returns ~2000 hits (jitter, IDs, test fixtures). These two match only the tell from
// stub-detection-audit: a random number standing in for a value/decision that reads as
// computed. Signal, not proof — read the surrounding function before calling it REAL/ABSENT.
const FABRICATION_PATTERNS = [
  { kind: 'fabricated-value', regex: /(confidence|accuracy|score|decision)\s*[:=][^\n]*Math\.random\(\)/i },
  { kind: 'fabricated-decision', regex: /return\s+Math\.random\(\)\s*[<>]/ },
];

const ARCH_SECTION_CAP = 40;
const ARCH_CONTENT_TRUNCATE = 8000;
const ARCH_TRUNCATE_MARKER = '\n\n[...truncated...]';

function completeEvidence() {
  return { ok: true, complete: true, partial: false, failed: false };
}

function partialEvidence(reason) {
  return { ok: false, complete: false, partial: true, failed: false, reason };
}

function failedEvidence(reason) {
  return { ok: false, complete: false, partial: false, failed: true, reason };
}

// Preserve legacy direct-object equality for two long-standing graceful-error
// results while exposing the full health schema to property readers and MCP JSON.
function compatibleFailedResult(data, reason) {
  const result = { ...data, ok: false, reason };
  const markers = { complete: false, partial: false, failed: true };
  for (const [key, value] of Object.entries(markers)) {
    Object.defineProperty(result, key, { value, enumerable: false });
  }
  Object.defineProperty(result, 'toJSON', {
    enumerable: false,
    value: () => ({ ...result, ...markers }),
  });
  return result;
}

function skippedEvidence(reason) {
  return { ok: false, complete: false, partial: false, failed: false, skipped: true, reason };
}

function combineEvidence(results, fallbackReason) {
  if (!Array.isArray(results) || results.length === 0) return failedEvidence(fallbackReason);
  if (results.every((result) => completeForRecommendation(result))) return completeEvidence();
  const reason = results
    .filter((result) => result && result.reason)
    .map((result) => result.reason)
    .join('; ') || fallbackReason;
  return results.some((result) => result && result.failed !== true)
    ? partialEvidence(reason)
    : failedEvidence(reason);
}

function health(result, fallbackReason) {
  if (!result || typeof result !== 'object') return failedEvidence(fallbackReason);
  const markers = ['ok', 'complete', 'partial', 'failed'];
  if (!markers.every((marker) => typeof result[marker] === 'boolean')) {
    return failedEvidence(result.reason || fallbackReason);
  }
  const output = Object.fromEntries(
    ['ok', 'stale', 'partial', 'skipped', 'complete', 'failed', 'reason']
      .filter((field) => result[field] !== undefined)
      .map((field) => [field, result[field]])
  );
  return output;
}

function completeForRecommendation(result) {
  if (!result || typeof result !== 'object') return false;
  const markers = ['ok', 'complete', 'partial', 'failed'];
  if (!markers.every((field) => Object.hasOwn(result, field))) return false;
  return result.ok === true
    && result.complete === true
    && result.partial === false
    && result.failed === false
    && result.stale !== true
    && result.skipped !== true;
}

// --- Phase 4: deterministic recommendation synthesizer ---------------------
//
// Pure function — takes already-gathered tool results and returns a ranked
// array. Every recommendation is a rule-based inference over a real number
// from a real read-only tool. No fabrication, no model, no vague advice: if
// no rule's condition holds, the array is empty.

function defaultExecImpl(cmd, args, options) {
  const stdout = execFileSync(cmd, args, { encoding: 'utf8', ...options });
  return { stdout };
}

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function findRepoRoot(startPath, fsImpl) {
  let current = startPath;
  // If startPath is a file, begin from its directory.
  try {
    if (fsImpl.existsSync(current) && fsImpl.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch (error) {
    // ignore stat errors, fall through to walk from the given path
  }

  while (true) {
    const gitPath = path.join(current, '.git');
    if (fsImpl.existsSync(gitPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadManifest(manifestPath, fsImpl) {
  if (!manifestPath) {
    return { manifest: null, reason: 'No manifest path configured' };
  }
  if (!fsImpl.existsSync(manifestPath)) {
    return { manifest: null, reason: `Manifest not found at ${manifestPath}` };
  }
  try {
    const raw = fsImpl.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { manifest: null, reason: 'Manifest JSON is not an object' };
    }
    return { manifest: parsed, reason: null };
  } catch (error) {
    return { manifest: null, reason: `Invalid manifest JSON: ${error.message}` };
  }
}

function matchManifest(manifest, absPath) {
  if (!manifest || !Array.isArray(manifest.repos)) return null;
  for (const entry of manifest.repos) {
    const matches = Array.isArray(entry.match) ? entry.match : [];
    for (const glob of matches) {
      if (globToRegExp(glob).test(absPath)) return entry;
    }
  }
  return null;
}

function detectConfigFiles(repoRoot, fsImpl) {
  const detected = [];
  if (!repoRoot) return detected;

  for (const [file, platform] of Object.entries(CONFIG_FILE_PLATFORMS)) {
    const candidate = path.join(repoRoot, file);
    if (fsImpl.existsSync(candidate)) detected.push({ file, platform });
  }

  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  if (fsImpl.existsSync(workflowsDir)) {
    let entries = [];
    try {
      entries = fsImpl.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name));
    } catch (error) {
      entries = [];
    }
    entries.slice(0, 20).forEach((name) => {
      const filePath = path.join('.github', 'workflows', name);
      const absolutePath = path.join(workflowsDir, name);
      let content = '';
      try {
        content = fsImpl.readFileSync(absolutePath, 'utf8');
      } catch (error) {
        content = '';
      }
      const haystack = `${name}\n${content}`.toLowerCase();
      for (const { keyword, platform } of WORKFLOW_PLATFORM_KEYWORDS) {
        if (haystack.includes(keyword)) {
          detected.push({ file: filePath, platform: platform || 'unknown' });
          break;
        }
      }
    });
  }

  return detected;
}

// Dockerfile means "containerised", not "deploys here" — nearly every repo has
// one, so counting it as a competing target would make every result noisy.
const WEAK_PLATFORM_SIGNALS = new Set(['docker']);

function computeAgreement(canonicalPlatform, detected) {
  const detectedPlatforms = detected.map((d) => d.platform);
  if (canonicalPlatform) {
    if (detectedPlatforms.includes(canonicalPlatform)) {
      // The canonical target is present — but a config for a DIFFERENT platform
      // sitting alongside it is the classic cause of "production keeps reverting":
      // a stale duplicate project still wired to the repo, quietly serving or
      // quietly failing. Confirmed, but not with high confidence.
      const strays = [...new Set(detectedPlatforms.filter(
        (p) => p !== canonicalPlatform && !WEAK_PLATFORM_SIGNALS.has(p),
      ))];
      if (strays.length > 0) {
        return { agreement: 'confirmed-with-strays', confidence: 'medium', strays };
      }
      return { agreement: 'confirmed', confidence: 'high' };
    }
    if (detectedPlatforms.length === 0) {
      return { agreement: 'manifest-only', confidence: 'medium' };
    }
    return { agreement: 'conflict', confidence: 'low' };
  }
  if (detectedPlatforms.length > 0) {
    return { agreement: 'config-only', confidence: 'medium' };
  }
  return { agreement: 'unknown', confidence: 'low' };
}

function buildGuidance(agreement, canonical, strays) {
  if (agreement === 'conflict') {
    return 'Manifest and repo config disagree — investigate before deploying.';
  }
  if (agreement === 'confirmed-with-strays' && canonical) {
    const list = (strays || []).join(', ');
    return `Canonical target is ${canonical.platform}, but config for ${list} is also present. `
      + 'A leftover project on another platform is the usual cause of "production keeps reverting" — '
      + 'confirm it is disconnected, or delete the stray config.';
  }
  if (agreement === 'confirmed' && canonical) {
    if (canonical.platform === 'railway' && canonical.autoDeploy) {
      return 'Auto-deploys on merge to main — do not hand-deploy; verify with a new-code route.';
    }
    if (canonical.autoDeploy) {
      return `Auto-deploys via ${canonical.platform} — do not hand-deploy; verify with a new-code route.`;
    }
    return `Canonical target is ${canonical.platform}${canonical.service ? ` (${canonical.service})` : ''}.`;
  }
  if (agreement === 'manifest-only' && canonical) {
    return `Manifest says ${canonical.platform}, but no matching config file was found in the repo — verify manually.`;
  }
  if (agreement === 'config-only') {
    return 'Repo config suggests a deploy target, but it is not in the manifest — consider adding it.';
  }
  return 'No canonical deploy target known — check the manifest and repo config manually.';
}

function createBrainService({
  manifestPath,
  vaults,
  fsImpl = fs,
  execImpl = defaultExecImpl,
  dbPath = null,
  modelsDirs = [],
  registryDoc = null,
  sqliteBin = 'sqlite3',
  archDocs = [],
  fabricationDirs = [],
} = {}) {
  function whereDoesThisDeploy(inputPath) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      return { error: 'path is required' };
    }
    const absPath = path.resolve(inputPath);
    const repo = findRepoRoot(absPath, fsImpl);
    const { manifest, reason } = loadManifest(manifestPath, fsImpl);

    const manifestMatch = matchManifest(manifest, absPath);
    const detected = detectConfigFiles(repo, fsImpl);

    const canonicalPlatform = manifestMatch ? manifestMatch.platform : null;
    const { agreement, confidence, strays } = computeAgreement(canonicalPlatform, detected);

    const canonical = manifestMatch
      ? {
          platform: manifestMatch.platform || null,
          service: manifestMatch.service || null,
          branch: manifestMatch.branch || null,
          autoDeploy: manifestMatch.autoDeploy || false,
          verify: manifestMatch.verify || null,
          notes: manifestMatch.notes || null,
        }
      : null;

    const guidance = buildGuidance(agreement, canonical, strays);

    const result = {
      path: absPath,
      repo,
      canonical,
      detected,
      agreement,
      confidence,
      guidance,
      ...(strays && strays.length ? { strays } : {}),
    };

    if (!manifest && reason) {
      result.manifestNote = reason;
    }

    return result;
  }

  function collectGithubItems(repoDir) {
    const items = [];
    const failures = [];
    let completedReads = 0;
    try {
      const prOut = execImpl('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName', '--limit', '30'], { cwd: repoDir }).stdout;
      const prs = JSON.parse(prOut);
      for (const pr of prs) {
        items.push({
          source: 'github',
          ref: `PR #${pr.number}`,
          title: pr.title,
          location: repoDir,
          status: pr.headRefName || 'open',
        });
      }
      completedReads += 1;
    } catch (error) {
      failures.push(`GitHub PR read failed: ${error.message}`);
    }
    try {
      const issueOut = execImpl('gh', ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '30'], { cwd: repoDir }).stdout;
      const issues = JSON.parse(issueOut);
      for (const issue of issues) {
        items.push({
          source: 'github',
          ref: `#${issue.number}`,
          title: issue.title,
          location: repoDir,
          status: 'open',
        });
      }
      completedReads += 1;
    } catch (error) {
      failures.push(`GitHub issue read failed: ${error.message}`);
    }
    if (failures.length === 0) return { items, ...completeEvidence() };
    const reason = failures.join('; ');
    return completedReads > 0
      ? { items, ...partialEvidence(reason) }
      : { items, ...failedEvidence(reason) };
  }

  function collectGitItems(repoDir) {
    const items = [];
    const failures = [];
    let completedReads = 0;
    try {
      const branchOut = execImpl('git', ['-C', repoDir, 'for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads']).stdout;
      const lines = branchOut.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(\S+)\s*(\[.*\])?$/);
        if (!match) continue;
        const [, branch, track] = match;
        const hasAhead = track && track.includes('ahead');
        const noUpstream = !track;
        if (hasAhead || noUpstream) {
          items.push({
            source: 'git',
            ref: branch,
            title: noUpstream ? 'local branch, no upstream' : `local branch ${track}`,
            location: repoDir,
            status: 'unmerged',
          });
        }
      }
      completedReads += 1;
    } catch (error) {
      failures.push(`git branch read failed: ${error.message}`);
    }
    try {
      const worktreeOut = execImpl('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']).stdout;
      const worktreeCount = worktreeOut.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
      if (worktreeCount > 1) {
        items.push({
          source: 'git',
          ref: 'worktrees',
          title: `${worktreeCount} worktrees present`,
          location: repoDir,
          status: 'info',
        });
      }
      completedReads += 1;
    } catch (error) {
      failures.push(`git worktree read failed: ${error.message}`);
    }
    if (failures.length === 0) return { items, ...completeEvidence() };
    const reason = failures.join('; ');
    return completedReads > 0
      ? { items, ...partialEvidence(reason) }
      : { items, ...failedEvidence(reason) };
  }

  const VAULT_MATCH_CAP = 50;
  // Defensive wall-clock ceiling: a placeholder (not-yet-materialized) iCloud file can take
  // 1-2s per readFileSync regardless of file count. vaultMaxFiles alone can't guarantee a
  // fast call if a run of candidates happens to be unmaterialized, so we also bail out once
  // this budget is spent, even if fewer than vaultMaxFiles files were scanned.
  const VAULT_TIME_BUDGET_MS = 8000;

  function collectVaultItems(vaultMarkers, vaultMaxFiles) {
    const items = [];
    if (!vaults || Object.keys(vaults).length === 0) {
      return { items, ...failedEvidence('No vaults configured'), scanned: 0, total: 0 };
    }
    try {
      const failures = [];
      // eslint-disable-next-line global-require
      const { createObsidianVaultService } = require('./obsidian-vault');
      const service = createObsidianVaultService({ vaults, fsImpl });

      // Step 1: list candidate note paths per vault — readdir-only, fast even on iCloud.
      const candidates = [];
      let total = 0;
      for (const vaultAlias of Object.keys(vaults)) {
        const { notes } = service.listNotes(vaultAlias);
        total += notes.length;
        const root = fsImpl.realpathSync(vaults[vaultAlias]);
        for (const relPath of notes) {
          const absPath = path.join(root, relPath);
          let mtimeMs = 0;
          try {
            mtimeMs = fsImpl.statSync(absPath).mtimeMs;
          } catch (error) {
            failures.push(`vault stat failed for ${relPath}: ${error.message}`);
            mtimeMs = 0;
          }
          candidates.push({ vaultAlias, relPath, absPath, mtimeMs });
        }
      }

      // Step 2: most-recently-modified first — stat metadata is fast on iCloud.
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const toScan = candidates.slice(0, vaultMaxFiles);
      const lowerMarkers = vaultMarkers.map((marker) => marker.toLowerCase());

      // Step 3: bounded content reads — at most vaultMaxFiles readFileSync calls,
      // regardless of how rare a marker is, and never longer than the time budget.
      // This is the fix for the iCloud hang.
      const scanStart = Date.now();
      let scanned = 0;
      let timedOut = false;
      for (const candidate of toScan) {
        if (items.length >= VAULT_MATCH_CAP) break;
        if (Date.now() - scanStart >= VAULT_TIME_BUDGET_MS) {
          timedOut = true;
          break;
        }
        scanned += 1;
        let content;
        try {
          content = fsImpl.readFileSync(candidate.absPath, 'utf8');
        } catch (error) {
          failures.push(`vault read failed for ${candidate.relPath}: ${error.message}`);
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          if (items.length >= VAULT_MATCH_CAP) break;
          const lowerLine = line.toLowerCase();
          const matchedMarker = lowerMarkers.find((marker) => lowerLine.includes(marker));
          if (matchedMarker) {
            items.push({
              source: 'vault',
              ref: `${candidate.vaultAlias}:${candidate.relPath}`,
              title: line.trim(),
              location: candidate.relPath,
              status: 'open',
            });
          }
        }
      }

      const coverage = `scanned ${scanned} of ${total} notes, most-recent-first (content-read cap ${vaultMaxFiles})${
        timedOut ? `, stopped early at the ${VAULT_TIME_BUDGET_MS}ms time budget` : ''
      } — marker-sample, not exhaustive`;

      const evidence = failures.length > 0 || timedOut
        ? partialEvidence([
            ...failures,
            ...(timedOut ? [`vault scan exceeded ${VAULT_TIME_BUDGET_MS}ms time budget`] : []),
          ].join('; '))
        : completeEvidence();
      return {
        items,
        ...evidence,
        scanned,
        total,
        coverage,
      };
    } catch (error) {
      return { items, ...failedEvidence(error.message), scanned: 0, total: 0 };
    }
  }

  function backlog({
    repos,
    includeVault = false,
    vaultMarkers = DEFAULT_VAULT_MARKERS,
    vaultMaxFiles = 80,
  } = {}) {
    const repoDirs = [];
    if (Array.isArray(repos) && repos.length > 0) {
      repoDirs.push(...repos);
    } else {
      const cwdRoot = findRepoRoot(process.cwd(), fsImpl);
      if (cwdRoot) repoDirs.push(cwdRoot);
    }

    const items = [];
    const sources = {
      github: completeEvidence(),
      git: completeEvidence(),
      vault: { ...completeEvidence(), coverage: 'marker-sample (not exhaustive)' },
    };

    if (repoDirs.length === 0) {
      sources.github = failedEvidence('No repo directories resolved');
      sources.git = failedEvidence('No repo directories resolved');
    } else {
      const githubResults = [];
      const gitResults = [];

      for (const repoDir of repoDirs) {
        const githubResult = collectGithubItems(repoDir);
        items.push(...githubResult.items);
        githubResults.push(githubResult);

        const gitResult = collectGitItems(repoDir);
        items.push(...gitResult.items);
        gitResults.push(gitResult);
      }

      sources.github = combineEvidence(githubResults, 'GitHub unavailable');
      sources.git = combineEvidence(gitResults, 'git unavailable');
    }

    if (includeVault) {
      const vaultResult = collectVaultItems(vaultMarkers, vaultMaxFiles);
      items.push(...vaultResult.items);
      sources.vault = vaultResult.ok
        ? { ...completeEvidence(), coverage: vaultResult.coverage, scanned: vaultResult.scanned, total: vaultResult.total }
        : {
            ...health(vaultResult, 'vault unavailable'),
            coverage: vaultResult.coverage || 'marker-sample (not exhaustive)',
            scanned: vaultResult.scanned,
            total: vaultResult.total,
          };
    } else {
      sources.vault = {
        ...skippedEvidence('includeVault=false'),
        coverage: 'marker-sample (not exhaustive)',
      };
    }

    const bySource = items.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {});

    return {
      sources,
      items,
      counts: {
        total: items.length,
        bySource,
      },
    };
  }

  // --- Phase 2: read-only DB / model / analytics tools -------------------
  //
  // All DB access goes through the system `sqlite3` CLI in read-only mode via
  // execImpl with an argument array (never a shell string) — no sqlite npm
  // driver is added. Any table name interpolated into PRAGMA/COUNT queries is
  // first validated against ^[A-Za-z0-9_]+$ AND confirmed to exist in
  // sqlite_master, so untrusted `table` input can never reach the CLI as
  // anything but a bare identifier.

  function dbBasename() {
    return dbPath ? path.basename(dbPath) : null;
  }

  // Rows come back as an array of plain objects (one per result row, keyed by
  // column name) via the sqlite3 CLI's `-json` output mode — no manual
  // delimiter parsing needed.
  function execSqlRows(sql) {
    if (!dbPath) return failedEvidence('No database configured');
    try {
      if (!fsImpl.existsSync(dbPath)) return failedEvidence(`Database not found at ${dbPath}`);
      const stdout = execImpl(sqliteBin, ['-readonly', '-json', dbPath, sql]).stdout;
      const trimmed = stdout.trim();
      const rows = trimmed ? JSON.parse(trimmed) : [];
      if (!Array.isArray(rows)) return failedEvidence('sqlite query returned a non-array JSON result');
      return { ...completeEvidence(), rows };
    } catch (error) {
      return failedEvidence(error.message);
    }
  }

  function listSqliteTables() {
    return execSqlRows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  }

  function dbSchema(table) {
    if (!dbPath) {
      return compatibleFailedResult({ dbBasename: null }, 'No database configured');
    }
    try {
      if (!fsImpl.existsSync(dbPath)) {
        return { dbBasename: dbBasename(), ...failedEvidence(`Database not found at ${dbPath}`) };
      }
    } catch (error) {
      return { dbBasename: dbBasename(), ...failedEvidence(error.message) };
    }

    if (!table) {
      const result = listSqliteTables();
      if (!result.ok) return { dbBasename: dbBasename(), ...failedEvidence(result.reason) };
      const tables = result.rows.map((row) => row.name).filter(Boolean);
      return { dbBasename: dbBasename(), tableCount: tables.length, tables, ...completeEvidence() };
    }

    // SECURITY: reject anything that isn't a bare identifier before it can be
    // interpolated into a query — this is what makes CLI/SQL injection via
    // `table` impossible.
    if (!/^[A-Za-z0-9_]+$/.test(table)) {
      return { error: 'unknown table' };
    }

    const existing = listSqliteTables();
    if (!existing.ok) return { dbBasename: dbBasename(), ...failedEvidence(existing.reason) };
    const knownTables = new Set(existing.rows.map((row) => row.name));
    if (!knownTables.has(table)) {
      return { error: 'unknown table' };
    }

    const columnsResult = execSqlRows(`PRAGMA table_info(${table})`);
    const columns = columnsResult.ok
      ? columnsResult.rows.map((row) => ({
          name: row.name,
          type: row.type,
          notnull: Boolean(row.notnull),
          pk: Boolean(row.pk),
        }))
      : null;

    const indexResult = execSqlRows(`PRAGMA index_list(${table})`);
    const indexes = indexResult.ok ? indexResult.rows.map((row) => row.name) : null;

    const countResult = execSqlRows(`SELECT count(*) AS n FROM ${table}`);
    const rawRowCount = countResult.ok && countResult.rows[0] ? Number(countResult.rows[0].n) : null;
    const rowCount = Number.isFinite(rawRowCount) && rawRowCount >= 0 ? rawRowCount : null;
    const failures = [columnsResult, indexResult, countResult]
      .filter((result) => !result.ok)
      .map((result) => result.reason);
    if (countResult.ok && rowCount === null) failures.push(`Invalid row count returned for ${table}`);

    const evidence = failures.length > 0 ? partialEvidence(failures.join('; ')) : completeEvidence();
    return { dbBasename: dbBasename(), table, columns, indexes, rowCount, ...evidence };
  }

  function walkModelsDir(dir, depth, results, cappedRef, failures, directoriesReadRef, depthTruncatedRef) {
    if (depth > MODEL_MAX_DEPTH) {
      depthTruncatedRef.value = true;
      return;
    }
    if (cappedRef.value) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      directoriesReadRef.value += 1;
    } catch (error) {
      failures.push(`model directory read failed for ${dir}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      if (results.length >= MODEL_ARTIFACT_CAP) {
        cappedRef.value = true;
        return;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkModelsDir(entryPath, depth + 1, results, cappedRef, failures, directoriesReadRef, depthTruncatedRef);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (MODEL_EXTENSIONS.has(ext)) {
          let stat;
          try {
            stat = fsImpl.statSync(entryPath);
          } catch (error) {
            failures.push(`model stat failed for ${entryPath}: ${error.message}`);
            continue;
          }
          results.push({
            name: entry.name,
            dir: path.basename(dir),
            type: ext,
            sizeBytes: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString(),
          });
        }
      }
      if (results.length >= MODEL_ARTIFACT_CAP) {
        cappedRef.value = true;
        return;
      }
    }
  }

  function mlModels() {
    const artifacts = [];
    const cappedRef = { value: false };
    const directoriesReadRef = { value: 0 };
    const depthTruncatedRef = { value: false };
    const failures = [];
    for (const dir of modelsDirs) {
      if (cappedRef.value) break;
      let exists;
      try {
        exists = fsImpl.existsSync(dir);
      } catch (error) {
        failures.push(`model directory check failed for ${dir}: ${error.message}`);
        continue;
      }
      if (!exists) {
        failures.push(`model directory not found at ${dir}`);
        continue;
      }
      walkModelsDir(dir, 0, artifacts, cappedRef, failures, directoriesReadRef, depthTruncatedRef);
    }

    const byType = artifacts.reduce((acc, artifact) => {
      acc[artifact.type] = (acc[artifact.type] || 0) + 1;
      return acc;
    }, {});

    let registryAvailable = false;
    if (registryDoc) {
      try {
        registryAvailable = Boolean(fsImpl.existsSync(registryDoc));
      } catch (error) {
        failures.push(`model registry check failed for ${registryDoc}: ${error.message}`);
      }
    }

    const scanSkipped = modelsDirs.length === 0;
    const scanFailed = !scanSkipped && directoriesReadRef.value === 0;
    const evidence = scanSkipped
      ? skippedEvidence('No model directories configured')
      : (failures.length === 0 && !cappedRef.value && !depthTruncatedRef.value
          ? completeEvidence()
          : (scanFailed
              ? failedEvidence(failures.join('; ') || 'model directories unavailable')
              : partialEvidence([
                  ...failures,
                  ...(cappedRef.value ? [`model artifact scan capped at ${MODEL_ARTIFACT_CAP}`] : []),
                  ...(depthTruncatedRef.value ? [`model artifact scan reached depth limit ${MODEL_MAX_DEPTH}`] : []),
                ].join('; '))));
    const result = {
      count: scanFailed ? null : artifacts.length,
      byType,
      artifacts,
      registryAvailable,
      note:
        'On-disk artifacts only — presence does NOT mean a model is loaded or active; ' +
        'live model weights/accuracy are not read by this tool.',
      ...evidence,
    };
    if (cappedRef.value) {
      result.capped = `Capped at ${MODEL_ARTIFACT_CAP} artifacts — more may exist.`;
    }
    return result;
  }

  function analytics() {
    const base = {
      dbBasename: dbBasename(),
      source: 'local development database — NOT production; counts reflect this machine only',
    };
    if (!dbPath) return { ...base, ...failedEvidence('No database configured') };
    try {
      if (!fsImpl.existsSync(dbPath)) {
        return { ...base, ...failedEvidence(`Database not found at ${dbPath}`) };
      }
    } catch (error) {
      return { ...base, ...failedEvidence(error.message) };
    }

    const existing = listSqliteTables();
    if (!existing.ok) return { ...base, ...failedEvidence(existing.reason) };
    const knownTables = new Set(existing.rows.map((row) => row.name));

    const tables = [];
    const failures = [];
    // Raw prediction-log activity (context) and legacy feedback tables (context)
    // are tallied separately from the outcome ledger, which is the ONLY signal
    // that defines feedback coverage.
    let predictionActivityRows = 0;
    let legacyFeedbackRows = 0;
    let ledgerTotal = 0;
    let ledgerLabeled = 0;
    let ledgerPresent = false;
    let predictionActivityComplete = true;
    let legacyFeedbackComplete = true;
    let ledgerComplete = true;
    let largestPredictionTable = null;
    let largestPredictionRows = -1;

    for (const tableName of ANALYTICS_TABLES) {
      if (!knownTables.has(tableName)) continue;

      const countResult = execSqlRows(`SELECT count(*) AS n FROM ${tableName}`);
      const rawRows = countResult.ok && countResult.rows[0] ? Number(countResult.rows[0].n) : null;
      const rows = Number.isFinite(rawRows) && rawRows >= 0 ? rawRows : null;
      const entry = { name: tableName, rows };
      if (!countResult.ok) failures.push(`count query failed for ${tableName}: ${countResult.reason}`);
      else if (rows === null) failures.push(`count query returned invalid data for ${tableName}`);

      const columnsResult = execSqlRows(`PRAGMA table_info(${tableName})`);
      if (columnsResult.ok) {
        const columnNames = columnsResult.rows.map((row) => row.name);
        const tsColumn = ANALYTICS_TIMESTAMP_COLUMNS.find((col) => columnNames.includes(col));
        if (tsColumn) {
          const latestResult = execSqlRows(`SELECT MAX(${tsColumn}) AS latest FROM ${tableName}`);
          if (latestResult.ok && latestResult.rows[0] && latestResult.rows[0].latest) {
            entry.latest = latestResult.rows[0].latest;
          } else if (!latestResult.ok) {
            failures.push(`latest query failed for ${tableName}: ${latestResult.reason}`);
          }
        }
      } else {
        failures.push(`column query failed for ${tableName}: ${columnsResult.reason}`);
      }

      tables.push(entry);

      if (tableName === ANALYTICS_OUTCOME_LEDGER_TABLE) {
        ledgerPresent = true;
        if (rows === null) ledgerComplete = false;
        else ledgerTotal = rows;
      } else if (ANALYTICS_LEGACY_FEEDBACK_TABLES.includes(tableName)) {
        if (rows === null) legacyFeedbackComplete = false;
        else legacyFeedbackRows += rows;
      } else if (ANALYTICS_PREDICTION_TABLES.includes(tableName)) {
        if (rows === null) predictionActivityComplete = false;
        else predictionActivityRows += rows;
        if (rows !== null && rows > largestPredictionRows) {
          largestPredictionRows = rows;
          largestPredictionTable = tableName;
        }
      }
    }

    // The genuine closed-loop count: ledger rows whose outcome has been labeled
    // by a real signal. Only run once the ledger total is trustworthy.
    if (ledgerPresent && ledgerComplete) {
      const labeledResult = execSqlRows(
        `SELECT count(*) AS n FROM ${ANALYTICS_OUTCOME_LEDGER_TABLE} WHERE ${ANALYTICS_OUTCOME_LABEL_COLUMN} IS NOT NULL`
      );
      const rawLabeled = labeledResult.ok && labeledResult.rows[0] ? Number(labeledResult.rows[0].n) : null;
      if (labeledResult.ok && Number.isFinite(rawLabeled) && rawLabeled >= 0) {
        ledgerLabeled = rawLabeled;
      } else {
        ledgerComplete = false;
        failures.push(
          `labeled-outcome query failed for ${ANALYTICS_OUTCOME_LEDGER_TABLE}: ${labeledResult.reason || 'invalid data'}`
        );
      }
    }

    let seedSuspected = false;
    let seedNote;
    if (largestPredictionTable && largestPredictionRows > 0) {
      const sampleResult = execSqlRows(`SELECT user_id AS uid FROM ${largestPredictionTable} LIMIT 1`);
      if (!sampleResult.ok) {
        failures.push(`seed sample query failed for ${largestPredictionTable}: ${sampleResult.reason}`);
      } else {
        const sampledUser = sampleResult.rows[0] ? sampleResult.rows[0].uid : null;
        if (sampledUser && SEED_USER_PATTERN.test(sampledUser)) {
          seedSuspected = true;
          seedNote = `Prediction rows appear to be seed/demo/smoke data (e.g. user "${sampledUser}") — likely not production activity.`;
        }
      }
    }

    // Coverage is a same-id-space ratio: labeled outcomes / total outcome-ledger
    // rows. Raw prediction logs and legacy feedback tables never enter it.
    const safeLedgerTotal = ledgerComplete ? ledgerTotal : null;
    const safeLedgerLabeled = ledgerComplete ? ledgerLabeled : null;
    const safeCoverage = safeLedgerTotal === null || safeLedgerLabeled === null
      ? null
      : safeLedgerLabeled / Math.max(safeLedgerTotal, 1);
    const safePredictionActivity = predictionActivityComplete ? predictionActivityRows : null;
    const safeLegacyFeedback = legacyFeedbackComplete ? legacyFeedbackRows : null;
    const outcomeLedger = { total: safeLedgerTotal, labeled: safeLedgerLabeled, coverage: safeCoverage };

    if (failures.length > 0) {
      const allComplete = ledgerComplete && predictionActivityComplete && legacyFeedbackComplete;
      return {
        ...base,
        tables,
        totals: {
          rows: allComplete ? ledgerTotal + predictionActivityRows + legacyFeedbackRows : null,
          tableCount: tables.length,
        },
        predictionRows: safeLedgerTotal,
        feedbackRows: safeLedgerLabeled,
        feedbackCoverage: safeCoverage,
        outcomeLedger,
        predictionActivityRows: safePredictionActivity,
        legacyFeedbackRows: safeLegacyFeedback,
        status: 'partial',
        famineFlag: null,
        summary: 'Analytics evidence is incomplete; no health or activity conclusion was synthesized.',
        seedSuspected,
        ...(seedNote ? { note: seedNote } : {}),
        ...partialEvidence(failures.join('; ')),
      };
    }

    const feedbackCoverage = ledgerTotal > 0 ? ledgerLabeled / ledgerTotal : 0;
    // labeled > total is physically impossible except during a transient read
    // race between the two count queries; clamp the DISPLAYED percentage so it can
    // never render >100%. The raw ratio is left intact.
    const coveragePct = Math.min(Math.max(feedbackCoverage, 0), 1) * 100;

    let status;
    let famineFlag;
    let summary;
    if (ledgerTotal === 0 && predictionActivityRows === 0 && legacyFeedbackRows === 0) {
      status = 'no-activity';
      famineFlag = false;
      summary = 'No prediction or feedback activity in this database.';
    } else if (ledgerTotal === 0) {
      // Predictions and/or legacy feedback exist, but nothing entered the outcome
      // ledger — closed-loop coverage is unmeasurable. Honest neutral state, NOT a
      // famine alarm (that false alarm is exactly what this metric used to raise).
      // buildRecommendations surfaces a soft investigate rec above the activity floor.
      status = 'no-outcome-ledger';
      famineFlag = false;
      summary = `${predictionActivityRows} prediction-log row(s) recorded, but the outcome ledger (prediction_outcomes) is empty — closed-loop coverage cannot be measured yet.`;
    } else if (feedbackCoverage >= FEEDBACK_COVERAGE_FAMINE_THRESHOLD) {
      // Healthy coverage wins regardless of ledger size.
      status = 'ok';
      famineFlag = false;
      summary = `Feedback coverage ${coveragePct.toFixed(1)}% (${ledgerLabeled}/${ledgerTotal} outcome-ledger predictions labeled).`;
    } else if (ledgerTotal < FEEDBACK_LEDGER_MIN_FAMINE) {
      // Low coverage but too few outcomes to call famine honestly — just warming
      // up. Fully visible in the summary; never hidden, never alarmist.
      status = 'feedback-warming';
      famineFlag = false;
      summary = `Outcome ledger warming up: ${ledgerLabeled}/${ledgerTotal} labeled (coverage ${coveragePct.toFixed(1)}%); need ${FEEDBACK_LEDGER_MIN_FAMINE}+ ledger rows before judging famine.`;
    } else {
      status = 'feedback-famine';
      famineFlag = true;
      summary = `${ledgerLabeled}/${ledgerTotal} outcome-ledger predictions carry a real label (coverage ${coveragePct.toFixed(1)}%) — the feedback loop is not closing.`;
    }

    const result = {
      ...base,
      tables,
      totals: {
        rows: ledgerTotal + predictionActivityRows + legacyFeedbackRows,
        tableCount: tables.length,
      },
      predictionRows: ledgerTotal,
      feedbackRows: ledgerLabeled,
      feedbackCoverage,
      outcomeLedger: { total: ledgerTotal, labeled: ledgerLabeled, coverage: feedbackCoverage },
      predictionActivityRows,
      legacyFeedbackRows,
      status,
      famineFlag,
      summary,
      seedSuspected,
      ...completeEvidence(),
    };

    if (seedNote) result.note = seedNote;

    return result;
  }

  // --- Wiring audit: fabricated-core scan ---------------------------------
  //
  // Read-only static scan for the stub-detection-audit tell: a Math.random()
  // standing in for a value/decision that reads as computed (fake confidence,
  // fake accuracy, fake decisions). Two tight patterns only — see comment on
  // FABRICATION_PATTERNS for why a naive Math.random() grep is not used.

  function walkFabricationDir(
    dir,
    depth,
    results,
    cappedRef,
    filesScannedRef,
    failures,
    directoriesReadRef,
    depthTruncatedRef
  ) {
    if (depth > FABRICATION_MAX_DEPTH) {
      depthTruncatedRef.value = true;
      return;
    }
    if (cappedRef.value) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      directoriesReadRef.value += 1;
    } catch (error) {
      failures.add('fabrication scan directory read failed');
      return;
    }
    for (const entry of entries) {
      if (cappedRef.value) return;
      if (entry.isDirectory()) {
        if (FABRICATION_EXCLUDE_DIR_PATTERN.test(entry.name)) continue;
        walkFabricationDir(
          path.join(dir, entry.name),
          depth + 1,
          results,
          cappedRef,
          filesScannedRef,
          failures,
          directoriesReadRef,
          depthTruncatedRef
        );
        continue;
      }
      if (!entry.isFile()
          || !FABRICATION_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
          || FABRICATION_EXCLUDE_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      if (filesScannedRef.value >= FABRICATION_FILE_CAP) {
        cappedRef.value = true;
        return;
      }
      const filePath = path.join(dir, entry.name);
      let content;
      try {
        content = fsImpl.readFileSync(filePath, 'utf8');
      } catch (error) {
        failures.add('fabrication scan file read failed');
        continue;
      }
      filesScannedRef.value += 1;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (results.length >= FABRICATION_FINDING_CAP) {
          cappedRef.value = true;
          return;
        }
        const line = lines[i];
        const match = FABRICATION_PATTERNS.find(({ regex }) => regex.test(line));
        if (match) {
          results.push({ file: filePath, line: i + 1, kind: match.kind, snippet: line.trim().slice(0, 200) });
        }
      }
    }
  }

  function fabricationAudit({ dirs } = {}) {
    const scanDirs = Array.isArray(dirs) && dirs.length > 0 ? dirs : fabricationDirs;
    if (!scanDirs || scanDirs.length === 0) {
      return compatibleFailedResult({ findings: [] }, 'No scan directories configured');
    }

    const findings = [];
    const cappedRef = { value: false };
    const filesScannedRef = { value: 0 };
    const directoriesReadRef = { value: 0 };
    const depthTruncatedRef = { value: false };
    const failures = new Set();
    for (const dir of scanDirs) {
      if (cappedRef.value) break;
      let exists;
      try {
        exists = fsImpl.existsSync(dir);
      } catch (error) {
        failures.add('fabrication scan directory unavailable');
        continue;
      }
      if (!exists) {
        failures.add('fabrication scan directory unavailable');
        continue;
      }
      walkFabricationDir(
        dir,
        0,
        findings,
        cappedRef,
        filesScannedRef,
        failures,
        directoriesReadRef,
        depthTruncatedRef
      );
    }

    const byKind = findings.reduce((acc, f) => {
      acc[f.kind] = (acc[f.kind] || 0) + 1;
      return acc;
    }, {});
    const fileCount = new Set(findings.map((f) => f.file)).size;
    const gaps = [
      ...failures,
      ...(cappedRef.value ? ['fabrication scan limit reached'] : []),
      ...(depthTruncatedRef.value ? ['fabrication scan depth limit reached'] : []),
    ];
    const scanFailed = directoriesReadRef.value === 0;
    const evidence = gaps.length === 0
      ? completeEvidence()
      : (scanFailed ? failedEvidence(gaps.join('; ')) : partialEvidence(gaps.join('; ')));

    const result = {
      filesScanned: scanFailed ? null : filesScannedRef.value,
      count: scanFailed ? null : findings.length,
      fileCount: scanFailed ? null : fileCount,
      byKind,
      findings,
      source:
        'Static text-pattern scan for Math.random()-fed confidence/accuracy/score/decision leaves — ' +
        'a signal, not proof. Read the surrounding function before certifying REAL/ABSENT (see stub-detection-audit skill).',
      ...evidence,
    };
    if (cappedRef.value) {
      result.capped = `Capped at ${FABRICATION_FILE_CAP} files / ${FABRICATION_FINDING_CAP} findings — more may exist.`;
    }
    return result;
  }

  // --- Phase 3: read-only architecture docs / roadmap tools --------------

  function loadArchDocs() {
    const docs = [];
    for (const filePath of archDocs) {
      if (!fsImpl.existsSync(filePath)) continue;
      let content;
      try {
        content = fsImpl.readFileSync(filePath, 'utf8');
      } catch (error) {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const h1 = lines.find((line) => line.startsWith('# '));
      const basename = path.basename(filePath, path.extname(filePath));
      const name = h1 ? h1.replace(/^#\s*/, '').trim() : path.basename(filePath);
      const sections = lines
        .filter((line) => line.startsWith('## '))
        .map((line) => line.replace(/^##\s*/, '').trim())
        .slice(0, ARCH_SECTION_CAP);
      docs.push({ name, basename, sections, sizeBytes: content.length, content });
    }
    return docs;
  }

  function architecture(area) {
    const docs = loadArchDocs();
    const source = 'Curated architecture docs (gateway skills) — as current as those docs.';

    if (!area) {
      return {
        source,
        docs: docs.map(({ name, sections, sizeBytes }) => ({ name, sections, sizeBytes })),
      };
    }

    if (docs.length === 0) {
      return { error: 'no architecture docs configured' };
    }

    const areaLower = String(area).toLowerCase();
    const match = docs.find(
      (doc) => doc.name.toLowerCase().includes(areaLower) || doc.basename.toLowerCase().includes(areaLower)
    );

    if (!match) {
      return { error: 'no architecture doc matches', available: docs.map((doc) => doc.name) };
    }

    const matchedOn = match.name.toLowerCase().includes(areaLower) ? match.name : match.basename;
    const truncated = match.content.length > ARCH_CONTENT_TRUNCATE;
    const content = truncated ? match.content.slice(0, ARCH_CONTENT_TRUNCATE) + ARCH_TRUNCATE_MARKER : match.content;

    return { name: match.name, matchedOn, content };
  }

  return {
    whereDoesThisDeploy,
    backlog,
    dbSchema,
    mlModels,
    analytics,
    architecture,
    fabricationAudit,
  };
}

module.exports = { createBrainService, globToRegExp };
