// App Nimbo para Windows: uma janela que abre o Nimbo publicado (as atualizações do site chegam
// sem novo executável) e acrescenta o que o navegador não faz bem: seletor de tela/janela, áudio
// sem eco (capturador nativo) e login do Google pelo navegador do sistema.
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, Menu } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const path = require('path');

// NIMBO_URL aponta para outro endereço em testes (ex.: http://localhost:5173 com emuladores).
const APP_URL = process.env.NIMBO_URL || 'https://golive-ad118.web.app';
const APP_ORIGIN = new URL(APP_URL).origin;
const ICON = path.join(__dirname, 'icon.ico');
const AUDIO_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'nimbo-audio.exe')
  : path.join(__dirname, 'bin', 'nimbo-audio.exe');

let mainWindow;

app.setAppUserModelId('app.nimbo.desktop');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => focusMain());

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Só a janela principal, com o Nimbo carregado, fala com estes canais.
function fromApp(event) {
  return (
    mainWindow &&
    event.sender === mainWindow.webContents &&
    new URL(event.senderFrame?.url || 'about:blank').origin === APP_ORIGIN
  );
}

function handleApp(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromApp(event)) throw new Error('Unauthorized');
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// ---------- Login pelo navegador do sistema ----------
// O app abre /desktop-login no navegador com uma porta local e um código de uso único; a página
// faz o login do Google e envia a credencial para http://127.0.0.1:<porta>/callback.
let pendingLogin = null;

const LOGIN_DONE_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nimbo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef1ff;
font-family:Inter,Segoe UI,system-ui,sans-serif}div{text-align:center}h1{font-size:22px;margin:0 0 8px}
p{color:#9aa6c4;margin:0}</style></head><body><div><h1>Pronto, você entrou.</h1>
<p>Pode fechar esta aba e voltar ao app Nimbo.</p></div></body></html>`;

function cancelLogin(reason) {
  if (!pendingLogin) return;
  const { server, reject, timer } = pendingLogin;
  pendingLogin = null;
  clearTimeout(timer);
  server.close();
  reject(new Error(reason));
}

function signInWithBrowser() {
  cancelLogin('Login cancelado.');
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const received = Buffer.from(form.get('state') || '');
        const expected = Buffer.from(state);
        if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Link de login inválido.');
          return;
        }
        const idToken = form.get('idToken') || '';
        const accessToken = form.get('accessToken') || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN_DONE_PAGE);
        if (pendingLogin?.state !== state) return;
        clearTimeout(pendingLogin.timer);
        pendingLogin = null;
        server.close();
        focusMain();
        if (idToken) resolve({ idToken, accessToken });
        else reject(new Error('O Google não devolveu a credencial. Tente de novo.'));
      });
    });
    server.on('error', (e) => cancelLogin('Não foi possível iniciar o login: ' + e.message));
    server.listen(0, '127.0.0.1', () => {
      const timer = setTimeout(() => cancelLogin('O login expirou. Tente de novo.'), 5 * 60 * 1000);
      pendingLogin = { server, state, resolve, reject, timer };
      const url = `${APP_URL.replace(/\/$/, '')}/desktop-login?port=${server.address().port}&state=${state}`;
      if (process.env.NIMBO_LOGIN_PRINT) console.log('[nimbo] login:', url);
      else void shell.openExternal(url);
    });
  });
}

handleApp('nimbo:signIn', () => signInWithBrowser());
handleApp('nimbo:signIn:cancel', () => cancelLogin('Login cancelado.'));

// ---------- Seletor de tela e janela ----------
let audioWanted = false;
let pendingAudio = null;

handleApp('nimbo:capture:audio', (_event, wanted) => {
  audioWanted = Boolean(wanted);
});

// Jogos em tela cheia se minimizam quando você troca para o Nimbo, e o Chromium não lista janelas
// minimizadas. O capturador nativo lista essas janelas; ao escolher uma, ela volta à tela.
function listMinimized() {
  return new Promise((resolve) => {
    execFile(AUDIO_HELPER, ['list'], { timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      const windows = [];
      for (const line of stdout.split('\n')) {
        try {
          if (line.trim()) windows.push(JSON.parse(line));
        } catch {
          // Linha incompleta: ignora.
        }
      }
      resolve(windows);
    });
  });
}

async function minimizedSources(known) {
  const seen = new Set(known.map((s) => s.id.split(':')[1]));
  const own = new Set(app.getAppMetrics().map((m) => m.pid));
  const windows = (await listMinimized()).filter((w) => !seen.has(w.hwnd) && !own.has(w.pid));
  return Promise.all(
    windows.map(async (w) => {
      let icon = '';
      if (w.path) icon = (await app.getFileIcon(w.path, { size: 'small' }).catch(() => null))?.toDataURL() || '';
      return { id: `window:${w.hwnd}:0`, name: w.title, type: 'window', thumbnail: '', icon, minimized: true };
    }),
  );
}

function windowInfo(hwnd) {
  return new Promise((resolve) =>
    execFile(AUDIO_HELPER, ['info', hwnd], { timeout: 2000, windowsHide: true }, (error, stdout) => {
      try {
        resolve(error ? null : JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    }),
  );
}

// Monitor (fonte "screen:") onde está o retângulo dado em pixels físicos.
async function screenSourceFor(monitor) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (sources.length === 1) return sources[0];
  const center = screen.screenToDipPoint({
    x: Math.round((monitor.left + monitor.right) / 2),
    y: Math.round((monitor.top + monitor.bottom) / 2),
  });
  const display = screen.getDisplayNearestPoint(center);
  return sources.find((s) => s.display_id === String(display.id)) || null;
}

// Janela de jogo em tela cheia não gera imagem na captura de janela (o jogo desenha direto na tela).
// Nesse caso o vídeo vem do monitor do jogo, que funciona sem perder FPS, e o som continua só do
// jogo. Um jogo que estava minimizado leva um instante para voltar à tela cheia.
async function gameCapture(hwnd) {
  let info = await windowInfo(hwnd);
  for (let i = 0; i < 10 && info?.minimized; i++) {
    await new Promise((r) => setTimeout(r, 300));
    info = await windowInfo(hwnd);
  }
  if (!info?.fullscreen) return null;
  return screenSourceFor(info.monitor);
}

function restoreWindow(hwnd) {
  return new Promise((resolve) =>
    execFile(AUDIO_HELPER, ['restore', hwnd], { timeout: 2000, windowsHide: true }, () => resolve()),
  );
}

function chooseCaptureSource() {
  return new Promise((resolve) => {
    let settled = false;
    const channels = ['nimbo:picker:list', 'nimbo:picker:choose', 'nimbo:picker:cancel'];
    const picker = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 880,
      height: 640,
      minWidth: 680,
      minHeight: 500,
      title: 'Nimbo · Escolher o que transmitir',
      icon: ICON,
      backgroundColor: '#0b1020',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      channels.forEach((c) => ipcMain.removeHandler(c));
      if (!picker.isDestroyed()) picker.close();
      resolve(result);
    };
    const authorized = (event) => event.sender === picker.webContents;
    const minimizedById = new Map();
    const ownWindows = () =>
      BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId());
    picker.on('closed', () => settle(null));
    ipcMain.handle('nimbo:picker:list', async (event) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      const own = ownWindows();
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 400, height: 250 },
        fetchWindowIcons: true,
      });
      const visible = sources
        .filter((s) => !own.includes(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          type: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
        }));
      const minimized = await minimizedSources(sources);
      for (const m of minimized) minimizedById.set(m.id, m);
      return { audio: audioWanted, sources: [...visible, ...minimized] };
    });
    ipcMain.handle('nimbo:picker:choose', async (event, { id, audio }) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      let source = sources.find((s) => s.id === id);
      const minimized = minimizedById.get(id);
      if (!source && minimized) {
        await restoreWindow(id.split(':')[1]);
        await new Promise((r) => setTimeout(r, 700));
        source = { id, name: minimized.name };
      }
      if (!source) throw new Error('Fonte não encontrada');
      if (id.startsWith('window:')) {
        const hwnd = id.split(':')[1];
        const monitor = await gameCapture(hwnd);
        if (monitor) {
          settle({ source: monitor, label: source.name, audioArgs: ['window', hwnd], audio: Boolean(audio) });
          return true;
        }
      }
      settle({ source, audio: Boolean(audio) });
      return true;
    });
    ipcMain.handle('nimbo:picker:cancel', async (event) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      settle(null);
      return true;
    });
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'capture-picker.html')).catch((e) => {
      console.error(e);
      settle(null);
    });
  });
}

// ---------- Áudio sem eco (desktop/native/NimboAudio.cs) ----------
// Tela inteira: todo o som do PC menos o próprio Nimbo. Janela: só o som daquele aplicativo.
const audioSessions = new Map();

function audioArgs(source) {
  if (source.id.startsWith('window:')) return ['window', source.id.split(':')[1]];
  return ['exclude', String(process.pid)];
}

handleApp('nimbo:audio:start', (event) => {
  const request = pendingAudio;
  pendingAudio = null;
  if (!request) return null;
  const id = crypto.randomUUID();
  const child = spawn(AUDIO_HELPER, request.args, { windowsHide: true });
  const target = event.sender;
  let carry = Buffer.alloc(0);
  let errors = '';
  // Envia só blocos inteiros (4 bytes por amostra estéreo).
  child.stdout.on('data', (data) => {
    const all = carry.length ? Buffer.concat([carry, data]) : data;
    const usable = all.length - (all.length % 4);
    carry = all.subarray(usable);
    if (usable && !target.isDestroyed()) target.send('nimbo:audio:data', id, all.subarray(0, usable));
  });
  child.stderr.on('data', (data) => (errors += data));
  const finish = (error) => {
    if (!audioSessions.has(id)) return;
    audioSessions.delete(id);
    if (!target.isDestroyed()) target.send('nimbo:audio:end', id, error);
  };
  child.on('error', (e) => finish('Capturador de áudio indisponível: ' + e.message));
  child.on('exit', (code) => {
    const message = (errors.match(/ERROR (.*)/) || [])[1];
    finish(code ? message || `código ${code}` : '');
  });
  audioSessions.set(id, child);
  return { id, label: request.label };
});

handleApp('nimbo:audio:stop', (_event, id) => {
  const child = audioSessions.get(id);
  if (!child) return;
  audioSessions.delete(id);
  child.stdin.end();
  setTimeout(() => child.kill(), 1500).unref();
});

app.on('before-quit', () => {
  for (const child of audioSessions.values()) child.kill();
  audioSessions.clear();
});

// ---------- Atualização automática ----------
// O app instalado confere o último Release do GitHub ao abrir e a cada 6 horas; a versão nova é
// baixada em segundo plano e entra ao reiniciar (ou na próxima vez que o app abrir).
// Com o site aberto, o aviso aparece no próprio Nimbo; a caixa do Windows fica só de reserva.
let updater = null;
let updateReady = null;
let updateWatcher = null;

handleApp('nimbo:update:watch', (event) => {
  updateWatcher = event.sender;
  return updateReady;
});
handleApp('nimbo:update:install', () => {
  if (updater && updateReady) updater.quitAndInstall();
});

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.warn('[nimbo] atualização:', e?.message || e));
  let asked = false;
  autoUpdater.on('update-downloaded', async (info) => {
    updateReady = { version: info.version };
    if (updateWatcher && !updateWatcher.isDestroyed()) {
      updateWatcher.send('nimbo:update:ready', updateReady);
      return;
    }
    if (asked || !mainWindow || mainWindow.isDestroyed()) return;
    asked = true;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Nimbo',
      message: `A versão ${info.version} do Nimbo está pronta.`,
      detail: 'Reinicie para usar agora, ou ela entra sozinha na próxima vez que você abrir o app.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

// ---------- Janela principal ----------
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const appOnly = (origin) => {
    try {
      return new URL(origin).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && appOnly(origin),
  );
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission) && appOnly(wc.getURL())),
  );
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!appOnly(request.securityOrigin)) return callback({});
      const selected = await chooseCaptureSource();
      if (!selected) return callback({});
      pendingAudio = selected.audio
        ? { args: selected.audioArgs || audioArgs(selected.source), label: selected.label || selected.source.name }
        : null;
      callback({ video: selected.source });
    } catch (e) {
      console.error(e);
      callback({});
    }
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 850,
    minHeight: 590,
    title: 'Nimbo',
    icon: ICON,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links para fora do Nimbo abrem no navegador; a janela nunca sai do Nimbo.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (appOnly(url)) return;
    event.preventDefault();
    if (/^https:/.test(url)) void shell.openExternal(url);
  });
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')))
      mainWindow.webContents.reload();
  });
  setupAutoUpdate();
  await mainWindow.loadURL(APP_URL);
});

app.on('window-all-closed', () => app.quit());
