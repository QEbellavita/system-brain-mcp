#!/usr/bin/env node
'use strict';

// Drafts a deploy manifest by looking at what you actually have.
//
// The manifest is the only hard part of using this tool, and asking someone to
// hand-author JSON describing infrastructure they already find confusing is how
// a tool goes unused. So: scan for git repos, read their platform config files,
// ask the platform CLIs what they know, and write a draft with everything it
// could work out already filled in.
//
//   node bin/init.js ~/code ~/work        # scan these roots
//   node bin/init.js --print              # stdout instead of writing
//
// The draft is a starting point, not an answer. Anywhere it guessed, it says so.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

// Dockerfile alone says "containerised", not "deployed here" — it is far too
// common to treat as a deploy signal on its own.
const WEAK_SIGNALS = new Set(['docker']);

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'target']);

function findRepos(root, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
    found.push(root);
    return found; // don't descend into a repo looking for more repos
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    findRepos(path.join(root, entry.name), depth + 1, found);
  }
  return found;
}

function detectPlatforms(repo) {
  const hits = [];
  for (const [file, platform] of Object.entries(CONFIG_FILE_PLATFORMS)) {
    if (fs.existsSync(path.join(repo, file))) hits.push({ file, platform });
  }
  return hits;
}

function currentBranch(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'branch', '--show-current'],
      { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function remoteSlug(repo) {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', timeout: 5000 }).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function cliAvailable(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Ask a platform CLI what it thinks this directory is linked to. */
function probeLinked(repo) {
  const notes = [];
  if (fs.existsSync(path.join(repo, '.vercel', 'project.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(repo, '.vercel', 'project.json'), 'utf8'));
      if (p.projectName) notes.push({ platform: 'vercel', service: p.projectName, source: '.vercel/project.json' });
    } catch { /* unreadable link file tells us nothing */ }
  }
  // `railway status` reports the LAST-LINKED project when the working directory
  // isn't linked at all, so probing unconditionally attributes an unrelated
  // service to every repo it sees. Only ask when this repo shows its own
  // Railway linkage.
  const railwayLinked = fs.existsSync(path.join(repo, '.railway'))
    || fs.existsSync(path.join(repo, 'railway.json'))
    || fs.existsSync(path.join(repo, 'railway.toml'));
  if (railwayLinked && cliAvailable('railway')) {
    try {
      const out = execFileSync('railway', ['status', '--json'],
        { cwd: repo, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const parsed = JSON.parse(out);
      if (parsed && parsed.name) notes.push({ platform: 'railway', service: parsed.name, source: 'railway status' });
    } catch { /* not linked, or CLI not authenticated */ }
  }
  return notes;
}

function buildEntry(repo) {
  const detected = detectPlatforms(repo);
  const linked = probeLinked(repo);
  const strong = detected.filter((d) => !WEAK_SIGNALS.has(d.platform));

  // Prefer what a CLI actually reports over what a config file implies.
  let platform = linked.length === 1 ? linked[0].platform
    : (strong.length === 1 ? strong[0].platform : null);
  let service = linked.length === 1 ? linked[0].service : null;

  const uncertain = [];
  if (!platform && strong.length > 1) {
    uncertain.push(`multiple platform configs found (${strong.map((d) => d.file).join(', ')}) — pick the canonical one`);
    platform = strong[0].platform;
  }
  if (!platform && strong.length === 0) {
    uncertain.push('no platform config detected — set platform manually, or this repo may not deploy');
  }
  if (linked.length > 1) {
    uncertain.push(`linked to more than one platform (${linked.map((l) => l.platform).join(', ')})`);
  }
  if (!service) uncertain.push('service name unknown — fill in the name your platform shows');

  return {
    match: [path.join(repo, '**')],
    platform,
    service,
    branch: currentBranch(repo),
    autoDeploy: null,
    verify: null,
    notes: remoteSlug(repo) ? `origin: ${remoteSlug(repo)}` : null,
    _detected: detected.map((d) => d.file),
    _uncertain: uncertain.length ? uncertain : undefined,
  };
}

function main() {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');
  const roots = args.filter((a) => !a.startsWith('--'));
  const scanRoots = roots.length ? roots : [process.cwd()];

  process.stderr.write(`scanning: ${scanRoots.join(', ')}\n`);
  const repos = scanRoots.flatMap((r) => findRepos(path.resolve(r)));
  process.stderr.write(`found ${repos.length} git repo(s)\n`);

  const entries = repos.map((repo) => {
    process.stderr.write(`  ${path.basename(repo)}\n`);
    return buildEntry(repo);
  });

  const manifest = {
    $comment: 'Draft generated by system-brain init. Fields left null, and anything under _uncertain, need your review. Delete the _detected/_uncertain keys once you have confirmed an entry.',
    repos: entries,
  };
  const json = JSON.stringify(manifest, null, 2);

  if (printOnly) {
    process.stdout.write(`${json}\n`);
    return;
  }

  const out = process.env.SYSTEM_BRAIN_DEPLOY_MANIFEST
    || path.join(os.homedir(), '.config', 'system-brain', 'deploy-targets.json');
  if (fs.existsSync(out)) {
    process.stderr.write(`\nrefusing to overwrite ${out}\n`);
    process.stderr.write('Re-run with --print and merge by hand.\n');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${json}\n`);

  const needsReview = entries.filter((e) => e._uncertain).length;
  process.stderr.write(`\nwrote ${out}\n`);
  process.stderr.write(`${entries.length} repo(s); ${needsReview} need review before the manifest is trustworthy.\n`);
}

main();
