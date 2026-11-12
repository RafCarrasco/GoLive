// Execute the unmodified Electron source in a VM. All native/Electron/update
// side effects are doubles; only the login server uses real loopback HTTP.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../../', import.meta.url));
const source = (name) => readFileSync(path.join(desktop, name), 'utf8');
export async function createOracle(options = {}) {
  const h = { handlers: new Map(), windows: [], children: [], servers: [], logs: [], installs: [], updateChecks: 0, nativeInfo: null, appURL: 'https://golive-ad118.web.app' };
  const renderer = h.renderer = new EventEmitter();
  const timers = new Set(), intervals = new Set();
  const schedule = (set) => (fn, ms) => {
    const timer = { fn, ms, unref() { return this; } };
    set.add(timer);
    return timer;
  };
  h.fireTimeout = (ms) => {
    for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn(); }
  };
  h.fireInterval = (ms) => { for (const timer of intervals) if (timer.ms === ms) timer.fn(); };
  let readyWork;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: Boolean(options.packaged),
    commandLine: { appendSwitch() {} },
    setAppUserModelId() {}, requestSingleInstanceLock: () => true, quit() {},
    whenReady: () => ({ then(fn) { readyWork = fn; } }),
    getAppMetrics: () => [{ pid: process.pid }],
    getFileIcon: async () => ({ toDataURL: () => 'data:native-icon' }),
    getVersion: () => '0.4.1', getPath: () => '/fixture-user-data',
  });
  const ipcMain = {
    handle(channel, fn) {
      if (h.handlers.has(channel)) throw new Error('duplicate channel: ' + channel);
      h.handlers.set(channel, fn);
    },
    removeHandler: (channel) => h.handlers.delete(channel),
  };
  class Window extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.destroyed = false;
      this.focusCount = 0;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        isDestroyed: () => this.destroyed,
        // Electron IPC structured-clones Node Buffers into renderer Uint8Arrays.
        // Passing Buffer by reference gives .slice() different semantics and
        // would falsely expose the pooled backing allocation to the consumer.
        send: (channel, ...args) => renderer.emit(channel, {}, ...args.map((arg) => structuredClone(arg))),
        setWindowOpenHandler(fn) { this.openHandler = fn; },
        getURL: () => h.appURL,
        reload() {},
      });
      h.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {} show() {} focus() { this.focusCount++; }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    getMediaSourceId() { return `window:own-${h.windows.indexOf(this)}:0`; }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    setBounds(bounds) { this.bounds = bounds; }
    async loadURL() {}
    async loadFile() {}
    static getAllWindows() { return h.windows.filter((w) => !w.destroyed); }
  }
  const browserURLs = [], browserWaiters = [];
  const session = { defaultSession: {
    setPermissionCheckHandler(fn) { h.permissionCheck = fn; },
    setPermissionRequestHandler(fn) { h.permissionRequest = fn; },
    setDisplayMediaRequestHandler(fn) { h.displayMedia = fn; },
  } };
  const updater = h.updater = new EventEmitter();
  Object.assign(updater, {
    setFeedURL(feed) { h.feed = feed; },
    async checkForUpdates() { h.updateChecks++; },
    quitAndInstall(...args) { h.installs.push(args); },
  });
  const electron = {
    app, BrowserWindow: Window, ipcMain, session,
    Menu: { setApplicationMenu() {} },
    dialog: { async showMessageBox() { return { response: 1 }; } },
    shell: { async openExternal(url) {
      if (browserWaiters.length) browserWaiters.shift()(new URL(url));
      else browserURLs.push(new URL(url));
    } },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ id: 1 }),
      screenToDipPoint: (p) => p,
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
    desktopCapturer: { async getSources({ types }) {
      const image = (data) => ({ isEmpty: () => false, toDataURL: () => data });
      return [
        { id: 'screen:1:0', display_id: '1', name: 'Fixture screen', thumbnail: image('data:thumbnail') },
        { id: 'window:42:0', name: 'Fixture window', thumbnail: image('data:thumbnail'), appIcon: image('data:icon') },
        ...Window.getAllWindows().map((w) => ({ id: w.getMediaSourceId(), name: 'Own Nimbo window', thumbnail: image('own') })),
      ].filter((s) => types.includes(s.id.startsWith('screen:') ? 'screen' : 'window'));
    } },
  };
  const childProcess = {
    execFile(_file, args, _config, callback) {
      const [command] = args;
      const value = command === 'list' ? options.nativeWindows || [] : options.nativeProcesses || [];
      const stdout = command === 'info' ? JSON.stringify(h.nativeInfo) : command === 'restore' ? '' : value.map((v) => JSON.stringify(v)).join('\n');
      callback(null, stdout, '');
    },
    spawn(_file, args) {
      const child = new EventEmitter();
      child.args = args;
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stdin = { ended: false, endCount: 0, end() { this.ended = true; this.endCount++; } };
      child.kill = () => { child.killed = true; };
      h.children.push(child);
      return child;
    },
  };
  const dependencies = {
    electron, child_process: childProcess, crypto: require('node:crypto'), path: require('node:path'), os: require('node:os'),
    http: { createServer(fn) { const server = http.createServer(fn); h.servers.push(server); return server; } },
    net: require('node:net'),
    fs: { appendFileSync(...args) { h.logs.push(args); }, existsSync: () => true },
    'electron-updater': { autoUpdater: updater },
  };
  const context = vm.createContext({
    require(name) {
      if (!(name in dependencies)) throw new Error('Unexpected oracle dependency: ' + name);
      return dependencies[name];
    },
    __dirname: desktop, Buffer, URL, URLSearchParams,
    process: { pid: process.pid, resourcesPath: '/fixture-resources', env: { NIMBO_UPDATE_URL: 'http://127.0.0.1:1/fixture-only' } },
    console: Object.fromEntries(['log', 'error', 'warn'].map((key) => [key, (...args) => h.logs.push(args)])),
    setTimeout: schedule(timers), clearTimeout: (id) => timers.delete(id), setInterval: schedule(intervals),
  });
  vm.runInContext(source('main.cjs'), context, { filename: 'desktop/main.cjs' });
  await readyWork();
  h.main = h.windows[0];
  h.evaluate = (expression) => vm.runInContext(expression, context);
  h.invoke = (channel, args = [], event = { sender: h.main.webContents, senderFrame: { url: h.appURL } }) => {
    const fn = h.handlers.get(channel);
    if (!fn) throw new Error('No handler for ' + channel);
    return fn(event, ...args);
  };
  const preload = (name) => {
    let bridge;
    const ipcRenderer = Object.assign(renderer, { invoke: (channel, ...args) => h.invoke(channel, args) });
    vm.runInNewContext(source(name), { require(name) {
      if (name !== 'electron') throw new Error('Unexpected preload dependency');
      return { contextBridge: { exposeInMainWorld(_name, api) { bridge = api; } }, ipcRenderer };
    } }, { filename: `desktop/${name}` });
    return bridge;
  };
  h.bridge = preload('preload.cjs');
  h.pickerBridge = preload('capture-preload.cjs');
  h.emit = (channel, ...args) => renderer.emit(channel, {}, ...args);
  h.capture = (origin = h.appURL) => new Promise((resolve) => { void h.displayMedia({ securityOrigin: origin }, resolve); });
  h.nextBrowserURL = () => browserURLs.length ? Promise.resolve(browserURLs.shift()) : new Promise((resolve) => browserWaiters.push(resolve));
  h.close = async () => {
    h.evaluate("cancelLogin('fixture teardown'); stopHelpers()");
    for (const window of [...h.windows]) window.close();
    for (const server of h.servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    timers.clear(); intervals.clear(); renderer.removeAllListeners();
  };
  return h;
}

// Run unchanged src/desktop.ts after TypeScript transpilation, with deterministic
// Web Audio/track doubles. This checks JS consumers, not native media feasibility.
export function loadDesktopConsumer(bridge) {
  const h = { messages: [], revoked: [], audioClosed: false, disconnected: false };
  h.makeTrack = () => Object.assign(new EventEmitter(), {
    stop() { this.stopped = true; },
    addEventListener(event, callback) { this.on(event, callback); },
  });
  class AudioContext {
    constructor(options) { h.contextOptions = JSON.parse(JSON.stringify(options)); this.audioWorklet = { async addModule() {} }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [h.makeTrack()] } }; }
    async close() { h.audioClosed = true; }
  }
  class AudioWorkletNode {
    constructor() { this.port = { postMessage: (pcm) => h.messages.push(pcm) }; }
    connect() {} disconnect() { h.disconnected = true; }
  }
  const exports = {};
  const input = readFileSync(path.join(desktop, '../src/desktop.ts'), 'utf8');
  const result = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(result.outputText, {
    exports, window: { nimboDesktop: bridge }, AudioContext, AudioWorkletNode,
    Blob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: (url) => h.revoked.push(url) },
    console: { warn() {} },
  }, { filename: 'src/desktop.ts (transpiled unchanged)' });
  h.api = exports;
  return h;
}
