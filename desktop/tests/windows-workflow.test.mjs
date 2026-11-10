import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WINDOWS_DIAGNOSTIC } from '../scripts/check-scope.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/windows.yml', import.meta.url), 'utf8');

test('Windows diagnostic is manual-only, read-only, pinned Rust and artifact-only', () => {
  // Check the entire blob, not only matching safe-looking YAML keys. Extra jobs,
  // aliases, duplicate keys and commands inside multiline text cannot sneak in.
  const bytes = Buffer.from(workflow);
  const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(oid, WINDOWS_DIAGNOSTIC.oid);
  assert.equal(WINDOWS_DIAGNOSTIC.path, '.github/workflows/windows.yml');
  assert.match(workflow, /^name: Nimbo Rust Windows DIAGNOSTIC not capture$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:\npermissions:\n  contents: read\n/m);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /rustup toolchain install 1\.99\.1 --profile minimal --component rustfmt --component clippy/);
  assert.equal(readFileSync(new URL('../rust/rust-toolchain.toml', import.meta.url), 'utf8'), '[toolchain]\nchannel = "1.99.1"\nprofile = "minimal"\ncomponents = ["rustfmt", "clippy"]\n');
  assert.match(workflow, /cargo \+1\.99\.1 fmt --manifest-path desktop\/rust\/Cargo.toml --all -- --check/);
  for (const command of ['clippy', 'test', 'build']) {
    assert.ok(workflow.includes(`cargo +1.99.1 ${command} --manifest-path desktop/rust/Cargo.toml --locked`), command);
  }
  assert.match(workflow, /clippy[^\n]+--all-targets -- -D warnings/);
  assert.match(workflow, /build[^\n]+--release/);
  assert.match(workflow, /desktop\/rust\/target\/release\/nimbo-desktop.exe/);
  assert.match(workflow, /Get-FileHash[^\n]+-Algorithm SHA256/);
  assert.match(workflow, /size_bytes = \(Get-Item/);
  assert.match(workflow, /commit = \$env:GITHUB_SHA/);
  assert.match(workflow, /name: Nimbo-Rust-Windows-DIAGNOSTIC-not-capture/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /No GUI, real capture, audio, login or installer is implemented/);
  assert.match(workflow, /native linking\/API probe only/);
  assert.match(workflow, /WebView2 detection differences are not capture proof/);
  assert.doesNotMatch(workflow, /electron|npm |desktop:pack|secrets\s*[.[]|contents: write|gh release|git push|updater|Nimbo-Setup|latest\.yml/i);
});
