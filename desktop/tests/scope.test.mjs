import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, enumerateBase, checkScope, packageViolations } from '../scripts/check-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(new URL('./helpers/base-manifest.json', import.meta.url)));

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nimbo-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '--quiet');
  const objects = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  mkdirSync(path.join(dir, '.git/objects/info'), { recursive: true });
  writeFileSync(path.join(dir, '.git/objects/info/alternates'), objects + '\n');
  git(dir, 'read-tree', BASE);
  git(dir, 'checkout-index', '--all');
  git(dir, 'update-ref', 'HEAD', BASE);
  return dir;
}

const put = (dir, name, text) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
};

test('immutable manifest enumerates every pinned base blob and real tree passes', () => {
  assert.equal(BASE, '3c16cbbf2a4e6fcd5ce2274bafb3a3a73c4ad6eb');
  assert.equal(manifest.base, BASE);
  assert.deepEqual(manifest.blobs, enumerateBase(root));
  assert.equal(manifest.blobs.length, 74);
  assert.deepEqual(checkScope(root), []);
});

test('complement rejects modifications/deletions/mode changes, not just named web directories', (t) => {
  const dir = fixture(t);
  assert.deepEqual(checkScope(dir), []);
  for (const name of ['src/desktop.ts', 'public/baixar/index.html', 'desktop/main.cjs', 'docs/backlog.md', '.github/workflows/community-check.yml']) {
    const original = readFileSync(path.join(dir, name));
    put(dir, name, 'fixture mutation');
    assert.ok(checkScope(dir).some((v) => v.includes(name)), name);
    writeFileSync(path.join(dir, name), original);
  }
  unlinkSync(path.join(dir, 'desktop/icon.ico'));
  assert.ok(checkScope(dir).some((v) => v.includes('desktop/icon.ico')));
  chmodSync(path.join(dir, 'README.md'), 0o755);
  assert.ok(checkScope(dir).some((v) => v.includes('README.md')));
});

test('only checkpoint-1 new test/script paths allowed; tracked and untracked additions checked', (t) => {
  const dir = fixture(t);
  put(dir, 'desktop/tests/ok.mjs', 'test fixture');
  put(dir, 'desktop/scripts/ok.mjs', 'script fixture');
  assert.deepEqual(checkScope(dir), []);
  for (const name of ['src/new.ts', 'new-root.mjs', 'desktop/rust/Cargo.toml', '.github/workflows/desktop-check.yml', 'desktop/tests-escape/bad.mjs']) {
    put(dir, name, 'unauthorized fixture');
    assert.ok(checkScope(dir).some((v) => v.includes(name)), name);
    git(dir, 'add', '--', name);
    assert.ok(checkScope(dir).some((v) => v.includes(name)), 'staged ' + name);
    git(dir, 'reset', '--quiet', '--', name);
    unlinkSync(path.join(dir, name));
  }
});

test('CLI fails closed for protected mutation and a different base', (t) => {
  const dir = fixture(t);
  put(dir, 'src/main.tsx', 'fixture only');
  const cli = fileURLToPath(new URL('../scripts/check-scope.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [cli, '--root', dir], { encoding: 'utf8', stdio: 'pipe' }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /src\/main.tsx/);
    return true;
  });
  assert.throws(() => execFileSync(process.execPath, [cli, '--root', root], { env: { ...process.env, NIMBO_BASE: 'HEAD' }, stdio: 'pipe' }), (error) => error.status === 1);
});

test('parsed package policy permits only desktop keys and never web graph/version changes', () => {
  const before = JSON.parse(git(root, 'show', `${BASE}:package.json`));
  const allowed = structuredClone(before);
  allowed.main = 'desktop/rust/main';
  allowed.scripts['desktop:dev'] = 'desktop command';
  allowed.devDependencies.electron = 'fixture';
  allowed.build.appId = 'fixture';
  assert.deepEqual(packageViolations(before, allowed), []);
  for (const change of [
    (p) => { p.version = '999.0.0'; },
    (p) => { p.scripts.build = 'changed'; },
    (p) => { p.scripts['desktop:arbitrary'] = 'not approved'; },
    (p) => { p.devDependencies.react = 'changed'; },
    (p) => { p.dependencies.firebase = 'new'; },
    (p) => { delete p.devDependencies.vite; },
    (p) => { p.arbitrary = true; },
  ]) {
    const after = structuredClone(before);
    change(after);
    assert.ok(packageViolations(before, after).length);
  }
});

test('staged protected mutations cannot hide behind a restored worktree', (t) => {
  const dir = fixture(t);
  const name = 'src/desktop.ts';
  const original = readFileSync(path.join(dir, name));
  put(dir, name, 'staged fixture mutation');
  git(dir, 'add', '--', name);
  writeFileSync(path.join(dir, name), original);
  assert.ok(checkScope(dir).some((v) => v.includes(name) && v.includes('index')));
});

test('checkpoint 1 pins entire lockfile, including web transitive graph', (t) => {
  const dir = fixture(t);
  const lock = JSON.parse(readFileSync(path.join(dir, 'package-lock.json')));
  lock.packages['node_modules/react'].version = '999.0.0';
  put(dir, 'package-lock.json', JSON.stringify(lock));
  assert.ok(checkScope(dir).some((v) => v.includes('package-lock.json')));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json')));
  pkg.scripts['desktop:dev'] = 'future desktop change';
  put(dir, 'package.json', JSON.stringify(pkg));
  assert.ok(checkScope(dir).some((v) => v.includes('package.json')), 'even permitted future desktop edits require a later checkpoint');
});
