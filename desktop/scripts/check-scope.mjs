// Approved checkpoints 1–2 only: every existing base blob stays immutable.
// Rust additions do not authorize legacy edits, workflows or shared manifest edits.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = '3c16cbbf2a4e6fcd5ce2274bafb3a3a73c4ad6eb';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
export function enumerateBase(root) {
  return git(root, 'ls-tree', '-rz', BASE).split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== 'blob') throw new Error('Unexpected non-blob base entry');
    return { path: match[4], mode: match[1], oid: match[3] };
  });
}
const DESKTOP_SCRIPTS = new Set(['desktop:dev', 'desktop:pack', 'desktop:audio']);
const DESKTOP_DEPS = new Set(['electron', 'electron-builder', 'electron-updater']);
// Parsed shared-manifest policy for later approved desktop checkpoints. This is
// additional validation, never permission to change the checkpoint-1 blobs.
export function packageViolations(before, after) {
  const protectedView = (pkg) => {
    const copy = structuredClone(pkg);
    delete copy.main;
    delete copy.build;
    for (const key of DESKTOP_SCRIPTS) delete copy.scripts?.[key];
    for (const section of ['dependencies', 'devDependencies']) {
      for (const key of DESKTOP_DEPS) delete copy[section]?.[key];
    }
    return copy;
  };
  return isDeepStrictEqual(protectedView(before), protectedView(after)) ? [] : ['package.json: protected keys/scripts/web dependencies changed'];
}
export function checkScope(root) {
  if (process.env.NIMBO_BASE && process.env.NIMBO_BASE !== BASE) throw new Error(`NIMBO_BASE must equal pinned ${BASE}`);
  const violations = [];
  git(root, 'merge-base', '--is-ancestor', BASE, 'HEAD');
  const blobs = enumerateBase(root);
  const basePaths = new Set(blobs.map((blob) => blob.path));
  const index = new Map(git(root, 'ls-files', '--stage', '-z').split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Unexpected index entry');
    return [match[4], { mode: match[1], oid: match[2], stage: match[3] }];
  }));
  for (const blob of blobs) {
    const staged = index.get(blob.path);
    if (!staged || staged.stage !== '0' || staged.mode !== blob.mode || staged.oid !== blob.oid) {
      violations.push(`${blob.path}: immutable base blob/mode changed in index`);
    }
    const file = path.join(root, blob.path);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) { violations.push(`${blob.path}: not a regular file`); continue; }
      const bytes = readFileSync(file);
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const mode = stat.mode & 0o111 ? '100755' : '100644';
      if (oid !== blob.oid || mode !== blob.mode) violations.push(`${blob.path}: immutable base blob/mode changed`);
    } catch (error) {
      violations.push(`${blob.path}: missing/unreadable (${error.code || error.message})`);
    }
  }
  // Includes staged, committed and non-ignored untracked files, not just git diff.
  // Existing ignored blobs are still checked above. Build/dependency/log output
  // excluded by the unchanged base .gitignore is not a new source file.
  const current = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  for (const name of new Set(current)) {
    if (basePaths.has(name)) continue;
    if (!/^(desktop\/tests\/|desktop\/scripts\/|desktop\/rust\/)/.test(name)) {
      violations.push(`${name}: unauthorized new path for checkpoints 1–2`);
      continue;
    }
    try {
      if (!lstatSync(path.join(root, name)).isFile()) violations.push(`${name}: new path must be a regular file`);
    } catch { violations.push(`${name}: missing new tracked file`); }
  }
  try {
    const before = JSON.parse(git(root, 'show', `${BASE}:package.json`));
    const after = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    violations.push(...packageViolations(before, after));
    const baseLock = JSON.parse(git(root, 'show', `${BASE}:package-lock.json`));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (!isDeepStrictEqual(baseLock, lock)) violations.push('package-lock.json: checkpoint-1 dependency graph must remain identical');
  } catch (error) { violations.push(`manifest validation: ${error.message}`); }
  return violations;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root')) throw new Error('Usage: node check-scope.mjs [--root path]');
    const root = args.length ? path.resolve(args[1]) : fileURLToPath(new URL('../../', import.meta.url));
    const violations = checkScope(root);
    if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
    else console.log(`CHECKPOINT_2_SCOPE_OK base=${BASE} immutable_blobs=${enumerateBase(root).length}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
