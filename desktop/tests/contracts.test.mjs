import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createOracle, loadDesktopConsumer } from './helpers/oracle.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function oracle(t, options) {
  const host = await createOracle(options);
  t.after(() => host.close());
  return host;
}
// One keep-alive agent per request: still a fresh connection every time, but the client closes it.
// With "Connection: close", Windows often resets loopback sockets before the response is read
// (ECONNRESET even against a bare Node server), which made these tests flaky there.
function post(url, body, method = 'POST', pathname = '/callback') {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: url.searchParams.get('port'), path: pathname, method, agent, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] }));
    });
    req.on('error', (e) => reject(Object.assign(e, { message: `${e.message} (${method} ${pathname} ${body.slice(0, 12)})` })));
    req.end(body);
  }).finally(() => agent.destroy());
}
async function login(host) {
  const outcome = host.bridge.signIn();
  const url = await host.nextBrowserURL();
  assert.equal(url.origin, 'https://golive-ad118.web.app');
  assert.equal(url.pathname, '/desktop-login');
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{48}$/);
  assert.ok(Number(url.searchParams.get('port')) > 0);
  assert.equal(host.servers.at(-1).address().address, '127.0.0.1');
  return { outcome, url };
}
const body = (url, idToken = 'synthetic-id', accessToken = 'synthetic-access') => new URLSearchParams({ state: url.searchParams.get('state'), idToken, accessToken }).toString();

test('preload v1 exact public surface, coercion, Result success/error and authorization', async (t) => {
  const h = await oracle(t);
  assert.deepEqual(Object.keys(h.bridge).sort(), ['version', 'signIn', 'cancelSignIn', 'setCaptureAudio', 'startAudio', 'stopAudio', 'watchUpdate', 'installUpdate', 'onUpdateProgress', 'startGameWatch', 'stopGameWatch', 'onGameState', 'onGameEnded', 'onAudio'].sort());
  assert.equal(h.bridge.version, 1);
  assert.deepEqual(plain(await h.bridge.startAudio()), { ok: true, value: null });
  assert.deepEqual(plain(await h.bridge.startGameWatch()), { ok: true, value: null });
  await h.bridge.setCaptureAudio('truthy');
  assert.equal(h.evaluate('audioWanted'), true);
  await h.bridge.setCaptureAudio(0);
  assert.equal(h.evaluate('audioWanted'), false);
  h.evaluate("handleApp('fixture:throw', () => { throw new Error('fixture failure'); })");
  assert.deepEqual(plain(await h.invoke('fixture:throw')), { ok: false, error: 'fixture failure' });
  await assert.rejects(h.invoke('nimbo:audio:start', [], { sender: {}, senderFrame: { url: h.appURL } }), /Unauthorized/);
  await assert.rejects(h.invoke('nimbo:audio:start', [], { sender: h.main.webContents, senderFrame: { url: 'https://evil.invalid' } }), /Unauthorized/);
});

test('typed Uint8Array PCM identity, session filtering, end and explicit listener cleanup', async (t) => {
  const h = await oracle(t);
  const chunks = [], ends = [];
  const cleanup = h.bridge.onAudio('a', (chunk) => chunks.push(chunk), (error) => ends.push(error));
  const pcm = new Uint8Array([0, 128, 255, 127]);
  h.emit('nimbo:audio:data', 'other', pcm);
  h.emit('nimbo:audio:end', 'other', 'ignored');
  h.emit('nimbo:audio:data', 'a', pcm);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0] instanceof Uint8Array);
  assert.equal(chunks[0], pcm);
  h.emit('nimbo:audio:end', 'a', null);
  assert.deepEqual(ends, ['']);
  assert.equal(h.renderer.listenerCount('nimbo:audio:data'), 0);
  assert.equal(h.renderer.listenerCount('nimbo:audio:end'), 0);
  cleanup();
  const stop = h.bridge.onAudio('b', () => assert.fail('removed'), () => assert.fail('removed'));
  stop(); stop();
  h.emit('nimbo:audio:data', 'b', pcm);
  assert.equal(h.renderer.listenerCount('nimbo:audio:data'), 0);
});

test('current loopback callback validates method/path/state then consumes synthetic Google credentials', async (t) => {
  const h = await oracle(t);
  const { outcome, url } = await login(h);
  assert.equal((await post(url, '', 'GET')).status, 404);
  assert.equal((await post(url, '', 'POST', '/wrong')).status, 404);
  assert.equal((await post(url, 'state=short')).status, 403);
  assert.equal((await post(url, 'state=' + 'z'.repeat(48))).status, 403);
  const response = await post(url, body(url));
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);
  assert.match(response.text, /Pronto, você entrou/);
  assert.ok(!response.text.includes('synthetic-id'));
  assert.deepEqual(plain(await outcome), { ok: true, value: { idToken: 'synthetic-id', accessToken: 'synthetic-access' } });
  assert.equal(h.evaluate('pendingLogin'), null);
  assert.ok(h.main.focusCount > 0);
  await tick();
  await assert.rejects(post(url, body(url)), /ECONNREFUSED|ECONNRESET|socket hang up/);
  assert.ok(!JSON.stringify(h.logs).includes('synthetic-id'));
});

test('missing credential, oversized body, replacement, cancel and five-minute expiry preserve current semantics', async (t) => {
  const h = await oracle(t);
  const missing = await login(h);
  assert.equal((await post(missing.url, body(missing.url, ''))).status, 200);
  assert.match((await missing.outcome).error, /Google/);
  const first = await login(h);
  await assert.rejects(post(first.url, 'x'.repeat(64 * 1024 + 1)), /ECONNRESET|socket hang up/);
  assert.notEqual(h.evaluate('pendingLogin'), null, 'oversize destroys request, not current pending login');
  const second = await login(h);
  assert.match((await first.outcome).error, /cancelado/);
  await h.bridge.cancelSignIn();
  assert.match((await second.outcome).error, /cancelado/);
  await tick();
  await assert.rejects(post(second.url, body(second.url)), /ECONNREFUSED|ECONNRESET|socket hang up/);
  const expired = await login(h);
  h.fireTimeout(5 * 60 * 1000);
  assert.match((await expired.outcome).error, /expirou/);
  assert.equal(h.evaluate('pendingLogin'), null);
});

async function select(h, id, audio) {
  const capture = h.capture();
  await tick();
  const picker = h.windows.at(-1);
  const event = { sender: picker.webContents };
  const listing = await h.invoke('nimbo:picker:list', [], event);
  await h.invoke('nimbo:picker:choose', [{ id, audio }], event);
  return { result: await capture, listing, picker };
}

test('capture picker returns thumbnails/icons, excludes own window, audio selection, cancel and cleanup', async (t) => {
  const h = await oracle(t);
  await h.bridge.setCaptureAudio(true);
  const { result, listing, picker } = await select(h, 'screen:1:0', true);
  assert.equal(listing.audio, true);
  assert.ok(listing.sources.some((s) => s.id === 'screen:1:0' && s.thumbnail === 'data:thumbnail'));
  assert.ok(listing.sources.some((s) => s.id === 'window:42:0' && s.icon === 'data:icon'));
  assert.ok(!listing.sources.some((s) => s.id === h.main.getMediaSourceId()));
  assert.equal(result.video.id, 'screen:1:0');
  assert.deepEqual(plain(h.evaluate('pendingAudio.args')), ['exclude', String(process.pid)]);
  assert.equal(picker.isDestroyed(), true);
  assert.equal(h.handlers.has('nimbo:picker:list'), false);
  assert.equal(h.main.listenerCount('focus'), 0);
  await select(h, 'window:42:0', false);
  assert.equal(h.evaluate('pendingAudio'), null);
  assert.equal((await h.bridge.startAudio()).value, null);
  const cancelled = h.capture();
  await tick();
  await h.invoke('nimbo:picker:cancel', [], { sender: h.windows.at(-1).webContents });
  assert.deepEqual(plain(await cancelled), {});
  assert.equal(h.handlers.has('nimbo:picker:choose'), false);
  assert.deepEqual(plain(await h.capture('https://evil.invalid')), {});
});

test('native minimized/process-only game listing, diagnostics and fullscreen monitor/audio/watch binding', async (t) => {
  const h = await oracle(t, { nativeWindows: [{ hwnd: '77', pid: 77, title: 'Minimized game', path: 'C:\\cs2.exe', visible: false, minimized: true }], nativeProcesses: [{ pid: 88, name: 'valorant-win64-shipping.exe' }] });
  const { listing, result } = await select(h, 'window:42:0', true);
  assert.ok(listing.sources.some((s) => s.id === 'window:77:0' && s.minimized));
  assert.ok(listing.sources.some((s) => s.id === 'game:88' && s.process && s.name === 'VALORANT'));
  assert.equal(result.video.id, 'window:42:0');
  assert.match(h.evaluate('captureDiagnostics()'), /cs2.exe|Minimized game/);
  h.nativeInfo = { fullscreen: true, monitor: { left: 0, top: 0, right: 1920, bottom: 1080 } };
  const fullscreen = await select(h, 'window:42:0', true);
  assert.equal(fullscreen.result.video.id, 'screen:1:0');
  assert.deepEqual(plain(h.evaluate('pendingAudio.args')), ['window', '42']);
  assert.deepEqual(plain(h.evaluate('pendingGame.args')), ['watch', '42']);
  const processOnly = await select(h, 'game:88', true);
  assert.equal(processOnly.result.video.id, 'screen:1:0');
  assert.deepEqual(plain(h.evaluate('pendingAudio.args')), ['include', '88']);
  assert.deepEqual(plain(h.evaluate('pendingGame.args')), ['watchpid', '88']);
});

test('audio stereo framing, one-shot request, pre-data fallback, stop and stale exit cleanup', async (t) => {
  const h = await oracle(t);
  await select(h, 'window:42:0', true);
  const started = await h.bridge.startAudio();
  assert.equal(started.ok, true);
  assert.equal(started.value.label, 'Fixture window');
  const id = started.value.id;
  const initial = h.children.at(-1);
  assert.deepEqual(plain(initial.args), ['window', '42']);
  assert.equal((await h.bridge.startAudio()).value, null);
  initial.emit('exit', 1);
  const fallback = h.children.at(-1);
  assert.notEqual(fallback, initial);
  assert.deepEqual(plain(fallback.args), ['exclude', String(process.pid)]);
  const chunks = [], ended = [];
  h.bridge.onAudio(id, (chunk) => chunks.push(chunk), (error) => ended.push(error));
  fallback.stdout.emit('data', Buffer.from([1, 2, 3]));
  assert.equal(chunks.length, 0);
  fallback.stdout.emit('data', Buffer.from([4, 5, 6, 7, 8, 9]));
  assert.deepEqual([...chunks[0]], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(chunks[0] instanceof Uint8Array);
  const count = h.children.length;
  fallback.emit('exit', 1);
  assert.equal(h.children.length, count, 'no second fallback');
  assert.equal(ended.length, 1);
  await select(h, 'window:42:0', true);
  const next = await h.bridge.startAudio();
  const child = h.children.at(-1);
  child.stdout.emit('data', Buffer.from([1]));
  child.emit('exit', 1);
  assert.equal(h.children.at(-1), child, 'even partial pre-frame data suppresses fallback in current oracle');
  await select(h, 'screen:1:0', true);
  const last = await h.bridge.startAudio();
  const stopped = h.children.at(-1);
  await h.bridge.stopAudio(last.value.id);
  assert.equal(stopped.stdin.ended, true);
  assert.equal(h.evaluate('audioSessions.size'), 0);
  stopped.emit('exit', 1);
  assert.equal(h.evaluate('audioSessions.size'), 0);
  h.fireTimeout(1500);
  assert.equal(stopped.killed, true);
  assert.ok(next.value.id);
});

test('game events handle fragmented lines, foreground/exit notifications and unsubscribe/stop', async (t) => {
  const h = await oracle(t);
  h.nativeInfo = { fullscreen: true, monitor: {} };
  await select(h, 'window:42:0', false);
  const { value } = await h.bridge.startGameWatch();
  assert.equal((await h.bridge.startGameWatch()).value, null);
  const states = [], ends = [];
  const stopState = h.bridge.onGameState(value.id, (active) => states.push(active));
  const stopEnd = h.bridge.onGameEnded(value.id, () => ends.push(true));
  h.emit('nimbo:game:state', 'other', true);
  h.emit('nimbo:game:ended', 'other');
  const child = h.children.at(-1);
  child.stdout.emit('data', '1\n0');
  child.stdout.emit('data', '\nx\n');
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(ends, [true]);
  child.emit('exit', 0);
  assert.deepEqual(states, [true, false, false]);
  stopState(); stopEnd();
  assert.equal(h.renderer.listenerCount('nimbo:game:state'), 0);
  assert.equal(h.renderer.listenerCount('nimbo:game:ended'), 0);
  await select(h, 'window:42:0', false);
  const again = await h.bridge.startGameWatch();
  const stopped = h.children.at(-1);
  await h.bridge.stopGameWatch(again.value.id);
  assert.equal(stopped.stdin.ended, true);
  h.fireTimeout(1500);
  assert.equal(stopped.killed, true);
});

test('fixture updater readiness/progress, six-hour polling, installer flags and helper shutdown', async (t) => {
  const h = await oracle(t, { packaged: true });
  assert.equal(h.updateChecks, 1);
  assert.equal(h.updater.autoDownload, true);
  assert.equal(h.updater.autoInstallOnAppQuit, true);
  assert.deepEqual(plain(h.feed), { provider: 'generic', url: 'http://127.0.0.1:1/fixture-only' });
  assert.equal((await h.bridge.installUpdate()).value, false);
  const ready = [], progress = [];
  assert.equal((await h.bridge.watchUpdate((info) => ready.push(plain(info)))).value, null);
  const unsubscribe = h.bridge.onUpdateProgress((percent) => progress.push(percent));
  h.updater.emit('download-progress', { percent: 42.6 });
  h.emit('nimbo:update:progress', 'invalid');
  assert.deepEqual(progress, [43, 0]);
  h.updater.emit('update-downloaded', { version: '0.4.2-fixture' });
  assert.deepEqual(ready, [{ version: '0.4.2-fixture' }]);
  assert.deepEqual(plain((await h.invoke('nimbo:update:watch')).value), { version: '0.4.2-fixture' });
  await select(h, 'screen:1:0', true);
  await h.bridge.startAudio();
  const child = h.children.at(-1);
  assert.equal((await h.bridge.installUpdate()).value, true);
  assert.equal(child.killed, true);
  assert.equal(h.evaluate('audioSessions.size + gameWatches.size'), 0);
  h.fireTimeout(300);
  assert.deepEqual(h.installs, [[true, true]]);
  h.fireInterval(6 * 60 * 60 * 1000);
  assert.equal(h.updateChecks, 2);
  unsubscribe();
  assert.equal(h.renderer.listenerCount('nimbo:update:progress'), 0);
  assert.equal(h.renderer.listenerCount('nimbo:update:ready'), 1, 'v1 watchUpdate has no unsubscribe; do not invent one');
});

test('unchanged TypeScript consumer unwraps Result, converts PCM and releases audio/game resources', async (t) => {
  const h = await oracle(t);
  const consumer = loadDesktopConsumer(h.bridge);
  h.handlers.delete('nimbo:signIn');
  h.evaluate("handleApp('nimbo:signIn', () => ({ idToken: 'synthetic', accessToken: '' }))");
  assert.deepEqual(plain(await consumer.api.desktopSignIn()), { idToken: 'synthetic', accessToken: '' });
  h.handlers.delete('nimbo:signIn');
  h.evaluate("handleApp('nimbo:signIn', () => { throw new Error('synthetic rejected'); })");
  await assert.rejects(consumer.api.desktopSignIn(), /synthetic rejected/);
  assert.equal(await consumer.api.desktopAudioTrack(), null);
  await select(h, 'screen:1:0', true);
  const track = await consumer.api.desktopAudioTrack();
  h.children.at(-1).stdout.emit('data', Buffer.from([0, 128, 255, 127]));
  assert.deepEqual([...consumer.messages[0]], [-32768, 32767]);
  assert.deepEqual(consumer.contextOptions, { sampleRate: 48000, latencyHint: 'interactive' });
  track.stop();
  assert.equal(consumer.audioClosed, true);
  assert.equal(consumer.disconnected, true);
  assert.equal(consumer.revoked.length, 1);
  assert.equal(h.renderer.listenerCount('nimbo:audio:data'), 0);
  h.nativeInfo = { fullscreen: true, monitor: {} };
  await select(h, 'window:42:0', false);
  const video = consumer.makeTrack();
  const stream = { getVideoTracks: () => [video] };
  await consumer.api.watchGameFor(stream);
  const watch = consumer.api.gameWatchOf(stream);
  const child = h.children.at(-1);
  child.stdout.emit('data', '0\nx\n');
  const states = [], ends = [];
  watch.onChange((active) => states.push(active));
  watch.onEnded(() => ends.push(true));
  assert.deepEqual(states, [false], 'late listener gets current state');
  assert.deepEqual(ends, [true], 'late listener gets ended');
  video.emit('ended'); video.stop(); watch.stop();
  assert.equal(h.renderer.listenerCount('nimbo:game:state'), 0);
  assert.equal(h.renderer.listenerCount('nimbo:game:ended'), 0);
  assert.equal(child.stdin.endCount, 1);
});
