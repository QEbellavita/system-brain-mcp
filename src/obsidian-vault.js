'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');
const { execFileSync } = require('child_process');
const path = require('path');

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_DEADLINE_MS = 20000;

// Only macOS evicts file contents while leaving the entry in place ("dataless"), and only
// its stat exposes the flag. Elsewhere a 0-block, 0-byte file is simply empty.
function datalessOnDisk(candidate) {
  if (process.platform !== 'darwin') return false;
  try {
    return execFileSync('/usr/bin/stat', ['-f', '%Sf', candidate], { encoding: 'utf8' }).includes('dataless');
  } catch {
    return false; // cannot tell => treat as empty rather than blame iCloud
  }
}

function createObsidianVaultService({ vaults, fsImpl = fs, now = Date.now, isDataless = datalessOnDisk }) {
  const roots = new Map(
    Object.entries(vaults || {}).map(([alias, root]) => [alias, fsImpl.realpathSync(root)])
  );

  function getRoot(vault) {
    const root = roots.get(vault);
    if (!root) throw new Error(`Unknown vault: ${vault}`);
    return root;
  }

  function validateNotePath(vault, notePath, { mustExist = false } = {}) {
    const root = getRoot(vault);
    if (typeof notePath !== 'string' || !notePath) throw new Error('Note path is required');
    if (path.isAbsolute(notePath)) throw new Error('Note path must be relative');
    if (path.extname(notePath).toLowerCase() !== '.md') throw new Error('Only Markdown notes are supported');

    const relative = notePath.split(path.sep).join('/');
    const candidate = path.resolve(root, notePath);
    const relativeToRoot = path.relative(root, candidate);
    if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new Error('Note path must remain inside the vault');
    }

    if (mustExist && !fsImpl.existsSync(candidate)) throw new Error(`Note does not exist: ${relative}`);

    let checkPath = candidate;
    if (!fsImpl.existsSync(checkPath)) {
      while (checkPath !== root && !fsImpl.existsSync(checkPath)) checkPath = path.dirname(checkPath);
    }
    const realCheckPath = fsImpl.realpathSync(checkPath);
    const realRelative = path.relative(root, realCheckPath);
    if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error('Note path must remain inside the vault');
    }

    return { root, candidate, relative };
  }

  // A vault may also be a source checkout. Descending into these
  // never yields notes, and macOS model bundles are the worst case: when iCloud has
  // evicted one, readdirSync on it blocks forever and the whole tool hangs.
  const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv']);
  const SKIPPED_DIR_EXTENSIONS = new Set([
    '.mlmodelc', '.mlpackage', '.framework', '.app', '.bundle', '.xcodeproj', '.xcworkspace',
  ]);

  function isNoteBearingDir(name) {
    if (name.startsWith('.')) return false; // .git, .obsidian, .trash
    if (SKIPPED_DIRS.has(name)) return false;
    return !SKIPPED_DIR_EXTENSIONS.has(path.extname(name).toLowerCase());
  }

  // stat() does not block on an evicted file, but read() does, so eviction must be detected
  // before reading. An evicted file has no blocks allocated locally — but so does a genuinely
  // empty note, and macOS reports the size of a dataless file inconsistently (the real size
  // for some, 0 for others). So blocks/size alone cannot separate "empty" from "evicted";
  // for that ambiguous case ask the filesystem for the actual dataless flag.
  function isMaterialized(candidate) {
    let stats;
    try {
      stats = fsImpl.statSync(candidate);
    } catch {
      return false;
    }

    if (stats.blocks > 0) return true;         // has local content
    if (stats.size > 0) return false;          // content exists but no local blocks => evicted
    return !isDataless(candidate);             // 0/0: empty local file, or an evicted one
  }

  // Reading a dataless file is what pulls it down from iCloud. Do that off the hot path so
  // the caller gets an answer now and the note is present on retry. Never rejects.
  const downloading = new Set();
  function requestDownload(candidate) {
    if (downloading.has(candidate)) return;
    downloading.add(candidate);
    Promise.resolve()
      .then(() => (fsImpl.promises || fsPromises).readFile(candidate, 'utf8'))
      .catch(() => {})
      .finally(() => downloading.delete(candidate));
  }

  function walkNotes(directory, root, result) {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isNoteBearingDir(entry.name)) continue;
        walkNotes(entryPath, root, result);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        result.push(path.relative(root, entryPath).split(path.sep).join('/'));
      }
    }
  }

  return {
    listNotes(vault, directory = '') {
      const root = getRoot(vault);
      const scope = directory ? validateNotePath(vault, path.join(directory, 'scope.md')).candidate.replace(/scope\.md$/, '') : root;
      if (!fsImpl.existsSync(scope)) return { vault, notes: [] };
      const notes = [];
      walkNotes(scope, root, notes);
      return { vault, notes: notes.sort() };
    },

    // Notes may be dataless iCloud placeholders, where each read blocks on a network
    // fetch. Bound the scan by wall-clock and report truncation rather than hang.
    searchNotes(vault, query, limit = DEFAULT_SEARCH_LIMIT, { deadlineMs = DEFAULT_SEARCH_DEADLINE_MS } = {}) {
      if (typeof query !== 'string' || !query) throw new Error('Search query is required');
      const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT));
      const notes = this.listNotes(vault).notes;
      const expiresAt = now() + deadlineMs;
      const matches = [];
      let scanned = 0;
      let unavailable = 0;
      let incomplete = false;

      for (const note of notes) {
        if (now() >= expiresAt) { incomplete = true; break; }
        const candidate = validateNotePath(vault, note, { mustExist: true }).candidate;

        // An evicted iCloud file reports blocks=0 with a non-zero size. Reading it blocks
        // indefinitely on a network fetch, and a sync read cannot be interrupted by the
        // deadline above, so skip it rather than hang the whole tool.
        if (!isMaterialized(candidate)) {
          unavailable += 1;
          incomplete = true;
          continue;
        }

        const content = fsImpl.readFileSync(candidate, 'utf8');
        scanned += 1;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase()) && matches.length < boundedLimit) {
            matches.push({ path: note, line: index + 1, excerpt: line });
          }
        });
        if (matches.length >= boundedLimit) break;
      }

      return {
        vault,
        query,
        matches,
        scanned,
        unavailable,
        total: notes.length,
        incomplete,
        ...(incomplete && {
          note: unavailable
            ? `Searched ${scanned}/${notes.length} notes; ${unavailable} are not downloaded from iCloud yet and were skipped. Results may be incomplete.`
            : `Search hit its ${deadlineMs}ms deadline after ${scanned}/${notes.length} notes. Results may be incomplete.`,
        }),
      };
    },

    readNote(vault, notePath) {
      const note = validateNotePath(vault, notePath, { mustExist: true });

      // A sync read of an evicted note blocks indefinitely while iCloud fetches it, which
      // hangs the caller with no way out. Request the download in the background and tell
      // the caller to retry, rather than freezing.
      if (!isMaterialized(note.candidate)) {
        requestDownload(note.candidate);
        throw new Error(
          `Note is not downloaded from iCloud yet: ${note.relative}. Download requested — retry in a moment.`
        );
      }

      return { vault, path: note.relative, content: fsImpl.readFileSync(note.candidate, 'utf8') };
    },

    createNote(vault, notePath, content) {
      const note = validateNotePath(vault, notePath);
      if (fsImpl.existsSync(note.candidate)) throw new Error(`Note already exists: ${note.relative}`);
      fsImpl.mkdirSync(path.dirname(note.candidate), { recursive: true });
      fsImpl.writeFileSync(note.candidate, String(content), 'utf8');
      return { vault, path: note.relative, status: 'created' };
    },

    updateNote(vault, notePath, content) {
      const note = validateNotePath(vault, notePath, { mustExist: true });
      const temporary = `${note.candidate}.${process.pid}.${Date.now()}.tmp`;
      try {
        fsImpl.writeFileSync(temporary, String(content), 'utf8');
        fsImpl.renameSync(temporary, note.candidate);
      } finally {
        if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
      }
      return { vault, path: note.relative, status: 'updated' };
    },
  };
}

module.exports = { createObsidianVaultService };
