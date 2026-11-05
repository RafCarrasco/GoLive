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
// O Nimbo transmite ao vivo: com a janela atrás do jogo ou minimizada, o Chromium economizava
// energia freando a página (a live de teste caiu de ~58 para ~1 quadro/s), e quem entrava via
// "Conectado, mas sem imagem". Nada de frear a página nem tratar janela coberta como escondida.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
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

// A lista do Chromium deixa de fora janelas minimizadas (jogos em tela cheia se minimizam quando
// você troca para o Nimbo) e pode omitir janelas de jogos protegidos por anticheat (Valorant).
// O capturador nativo lista todas as janelas de aplicativo; as que faltarem entram no seletor, e
// uma minimizada volta à tela ao ser escolhida.
let lastListing = { windows: [], error: '' };

function listWindows() {
  return new Promise((resolve) => {
    execFile(AUDIO_HELPER, ['list'], { timeout: 3000, windowsHide: true }, (error, stdout, stderr) => {
      const windows = [];
      for (const line of String(stdout || '').split('\n')) {
        try {
          if (line.trim()) windows.push(JSON.parse(line));
        } catch {
          // Linha incompleta: ignora.
        }
      }
      lastListing = { windows, error: error ? `${error.code || ''} ${error.message} ${stderr || ''}`.trim() : '' };
      resolve(windows);
    });
  });
}

// Jogos conhecidos (nome do executável sem .exe) e o nome mostrado no seletor. Janelas e processos
// deles entram no seletor mesmo que caiam nos filtros ou que nenhuma janela apareça.
const GAMES = {
  'valorant-win64-shipping': 'VALORANT',
  valorant: 'VALORANT',
  cs2: 'Counter-Strike 2',
  csgo: 'Counter-Strike',
  'league of legends': 'League of Legends',
  'fortniteclient-win64-shipping': 'Fortnite',
  r5apex: 'Apex Legends',
  r5apex_dx12: 'Apex Legends',
  gta5: 'GTA V',
  gtav: 'GTA V',
  rocketleague: 'Rocket League',
  overwatch: 'Overwatch 2',
  dota2: 'Dota 2',
  eldenring: 'Elden Ring',
  javaw: 'Minecraft',
  robloxplayerbeta: 'Roblox',
  cod: 'Call of Duty',
  tslgame: 'PUBG',
  destiny2: 'Destiny 2',
  rainbowsix: 'Rainbow Six Siege',
  'marvel-win64-shipping': 'Marvel Rivals',
  deadlock: 'Deadlock',
  project8: 'Deadlock',
};
const gameName = (exe) => GAMES[String(exe || '').toLowerCase().replace(/\.exe$/, '')] || '';
const exeOf = (filePath) => String(filePath || '').split(/[\\/]/).pop();
const GAME_EXE = { test: (filePath) => Boolean(gameName(exeOf(filePath))) };
// Tela cheia só conta se a janela estiver de fato visível (o Windows tem janelas de sistema escondidas
// do tamanho da tela); executável conhecido e janela da Unreal Engine valem sempre.
const isGameLike = (w) =>
  GAME_EXE.test(w.path || '') ||
  /UnrealWindow/i.test(w.class || '') ||
  (w.fullscreen && w.visible && !w.cloaked && !w.tool);
// Filtros de sempre: janela visível, sem dono, que não é auxiliar nem está escondida pelo Windows.
const isAppWindow = (w) => w.visible && !w.owned && !w.tool && !w.cloaked;

let lastProcesses = [];

function listProcesses() {
  return new Promise((resolve) => {
    execFile(AUDIO_HELPER, ['processes'], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      const processes = [];
      for (const line of String(stdout || '').split('\n')) {
        try {
          if (line.trim()) processes.push(JSON.parse(line));
        } catch {
          // Linha incompleta: ignora.
        }
      }
      lastProcesses = processes;
      resolve(processes);
    });
  });
}

async function missingSources(known) {
  const seen = new Set(known.map((s) => s.id.split(':')[1]));
  const own = new Set(app.getAppMetrics().map((m) => m.pid));
  const listing = await listWindows();
  const all = listing.filter((w) => !seen.has(w.hwnd) && !own.has(w.pid));
  const windows = all.filter(isAppWindow);
  // Um jogo pode ficar escondido ou "auxiliar" para o Windows. Entra a janela principal de cada
  // processo de jogo que ainda não estiver na lista (as de teclado/IME do jogo ficam de fora).
  const listed = new Set([...known.map((s) => s.id.split(':')[1]), ...windows.map((w) => w.hwnd)]);
  const listedPids = new Set([...windows, ...listing.filter((w) => seen.has(w.hwnd))].map((w) => w.pid));
  const score = (w) => (w.visible ? 4 : 0) + (w.owned ? 0 : 2) + (w.tool ? 0 : 1) + (w.minimized ? 1 : 0);
  const best = new Map();
  for (const w of all) {
    if (listed.has(w.hwnd) || listedPids.has(w.pid) || !isGameLike(w) || /^(IME|MSCTFIME UI)$/.test(w.class || '')) continue;
    const current = best.get(w.pid);
    if (!current || score(w) > score(current)) best.set(w.pid, w);
  }
  windows.push(...best.values());
  // Jogo rodando sem nenhuma janela na lista (o anticheat pode esconder até a janela): entra pelo
  // processo. Um item por jogo; a versão "-Shipping" (o jogo de fato) tem preferência.
  const shown = new Set([...listedPids, ...windows.map((w) => w.pid)]);
  const byGame = new Map();
  for (const p of await listProcesses()) {
    const name = gameName(p.name);
    if (!name || shown.has(p.pid) || own.has(p.pid)) continue;
    const current = byGame.get(name);
    if (!current || /shipping/i.test(p.name)) byGame.set(name, p);
  }
  const processSources = [...byGame].map(([name, p]) => ({
    id: `game:${p.pid}`,
    name,
    type: 'window',
    thumbnail: '',
    icon: '',
    minimized: false,
    process: true,
  }));
  return [...(await Promise.all(
    windows.map(async (w) => {
      let icon = '';
      if (w.path) icon = (await app.getFileIcon(w.path, { size: 'small' }).catch(() => null))?.toDataURL() || '';
      const name = w.title || gameName(exeOf(w.path)) || exeOf(w.path).replace(/\.exe$/i, '') || 'Janela sem título';
      return { id: `window:${w.hwnd}:0`, name, type: 'window', thumbnail: '', icon, minimized: Boolean(w.minimized) };
    }),
  )), ...processSources];
}

// Texto para o "Não achou o jogo?" do seletor: o que o capturador nativo viu e por quê.
function captureDiagnostics() {
  const { windows, error } = lastListing;
  const flags = (w) =>
    ['visible', 'owned', 'tool', 'cloaked', 'minimized', 'fullscreen'].filter((k) => w[k]).join(',') || '-';
  const relevant = windows.filter((w) => w.visible || isGameLike(w) || w.minimized);
  return [
    `Nimbo ${app.getVersion()} · Windows ${require('os').release()}`,
    `Capturador: ${require('fs').existsSync(AUDIO_HELPER) ? 'encontrado' : 'NÃO ENCONTRADO'}${error ? ' · ERRO: ' + error : ''}`,
    `Jogos em execução: ${lastProcesses.filter((p) => gameName(p.name)).map((p) => `${p.name} (${p.pid})`).join(', ') || 'nenhum'}`,
    `Janelas: ${windows.length} (mostrando ${relevant.length})`,
    ...relevant.map(
      (w) => `- ${w.title} | ${require('path').basename(w.path || '?')} | ${w.class} | ${flags(w)}${isGameLike(w) ? ' | JOGO' : ''}`,
    ),
  ].join('\n');
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
    const channels = ['nimbo:picker:list', 'nimbo:picker:choose', 'nimbo:picker:cancel', 'nimbo:picker:diagnostics'];
    const picker = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 880,
      height: 640,
      minWidth: 680,
      minHeight: 500,
      // Minimizado, o seletor vira um quadradinho no canto da tela e, como é modal, deixa o Nimbo
      // bloqueado (cada clique só faz o som de erro do Windows). Por isso não minimiza.
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
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
    const extraById = new Map();
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
      const extra = await missingSources(sources);
      for (const m of extra) extraById.set(m.id, m);
      return { audio: audioWanted, sources: [...visible, ...extra] };
    });
    ipcMain.handle('nimbo:picker:choose', async (event, { id, audio }) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      let source = sources.find((s) => s.id === id);
      if (id.startsWith('game:')) {
        const pid = Number(id.split(':')[1]);
        const name = extraById.get(id)?.name || 'Jogo';
        const score = (w) => (w.visible ? 4 : 0) + (w.owned ? 0 : 2) + (w.minimized ? 1 : 0);
        const window = lastListing.windows.filter((w) => w.pid === pid).sort((a, b) => score(b) - score(a))[0];
        let monitor = null;
        if (window) {
          if (window.minimized) await restoreWindow(window.hwnd);
          monitor = await gameCapture(window.hwnd);
        }
        if (!monitor) {
          const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
          monitor = screens.find((s) => s.display_id === String(screen.getPrimaryDisplay().id)) || screens[0];
        }
        if (!monitor) throw new Error('Nenhuma tela encontrada');
        settle({
          source: monitor,
          label: name,
          audioArgs: ['include', String(pid)],
          game: window?.hwnd || null,
          audio: Boolean(audio),
        });
        return true;
      }
      const extra = extraById.get(id);
      if (!source && extra) {
        if (extra.minimized) {
          await restoreWindow(id.split(':')[1]);
          await new Promise((r) => setTimeout(r, 700));
        }
        source = { id, name: extra.name };
      }
      if (!source) throw new Error('Fonte não encontrada');
      if (id.startsWith('window:')) {
        const hwnd = id.split(':')[1];
        const monitor = await gameCapture(hwnd);
        if (monitor) {
          settle({ source: monitor, label: source.name, audioArgs: ['window', hwnd], game: hwnd, audio: Boolean(audio) });
          return true;
        }
      }
      settle({ source, audio: Boolean(audio) });
      return true;
    });
    ipcMain.handle('nimbo:picker:diagnostics', async (event) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      return captureDiagnostics();
    });
    ipcMain.handle('nimbo:picker:cancel', async (event) => {
      if (!authorized(event)) throw new Error('Unauthorized');
      settle(null);
      return true;
    });
    // Abre centralizado na tela onde está o Nimbo (um jogo em tela cheia pode ter mudado a
    // resolução), e volta sozinho se algo o minimizar ou esconder.
    const display = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const width = Math.min(880, display.width - 40);
    const height = Math.min(640, display.height - 40);
    picker.setBounds({
      x: Math.round(display.x + (display.width - width) / 2),
      y: Math.round(display.y + (display.height - height) / 2),
      width,
      height,
    });
    const keepVisible = () => {
      if (picker.isDestroyed()) return;
      if (picker.isMinimized()) picker.restore();
      picker.show();
      picker.focus();
    };
    picker.on('minimize', keepVisible);
    mainWindow.on('focus', keepVisible);
    picker.on('closed', () => mainWindow.off('focus', keepVisible));
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
  const target = event.sender;
  // Se o Windows recusar o som só daquele aplicativo (jogo protegido por anticheat, por exemplo),
  // a sessão continua com o som do PC sem o Nimbo, em vez de ficar muda.
  const run = (args, fallback) => {
    const child = spawn(AUDIO_HELPER, args, { windowsHide: true });
    let carry = Buffer.alloc(0);
    let errors = '';
    let received = false;
    // Envia só blocos inteiros (4 bytes por amostra estéreo).
    child.stdout.on('data', (data) => {
      received = true;
      const all = carry.length ? Buffer.concat([carry, data]) : data;
      const usable = all.length - (all.length % 4);
      carry = all.subarray(usable);
      if (usable && !target.isDestroyed()) target.send('nimbo:audio:data', id, all.subarray(0, usable));
    });
    child.stderr.on('data', (data) => (errors += data));
    const finish = (error) => {
      if (audioSessions.get(id) !== child) return;
      if (error && fallback && !received) {
        console.warn('[nimbo] som só do aplicativo recusado, usando o som do PC:', error);
        run(fallback, null);
        return;
      }
      audioSessions.delete(id);
      if (!target.isDestroyed()) target.send('nimbo:audio:end', id, error);
    };
    child.on('error', (e) => finish('Capturador de áudio indisponível: ' + e.message));
    child.on('exit', (code) => {
      const message = (errors.match(/ERROR (.*)/) || [])[1];
      finish(code ? message || `código ${code}` : '');
    });
    audioSessions.set(id, child);
  };
  const appOnly = request.args[0] === 'window' || request.args[0] === 'include';
  run(request.args, appOnly ? ['exclude', String(process.pid)] : null);
  return { id, label: request.label };
});

handleApp('nimbo:audio:stop', (_event, id) => {
  const child = audioSessions.get(id);
  if (!child) return;
  audioSessions.delete(id);
  child.stdin.end();
  setTimeout(() => child.kill(), 1500).unref();
});

// ---------- Jogo em tela cheia: pausa quando sai da frente ----------
// Transmitindo o monitor de um jogo, um Alt+Tab mostraria a área de trabalho. O site troca o vídeo
// por uma tela de pausa enquanto o jogo não estiver na frente.
let pendingGame = null;
const gameWatches = new Map();

handleApp('nimbo:game:start', (event) => {
  const game = pendingGame;
  pendingGame = null;
  if (!game) return null;
  const id = crypto.randomUUID();
  const child = spawn(AUDIO_HELPER, ['watch', game.hwnd], { windowsHide: true });
  const target = event.sender;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines)
      if (line.trim() && !target.isDestroyed()) target.send('nimbo:game:state', id, line.trim() === '1');
  });
  child.on('exit', () => {
    gameWatches.delete(id);
    if (!target.isDestroyed()) target.send('nimbo:game:state', id, false);
  });
  child.on('error', () => gameWatches.delete(id));
  gameWatches.set(id, child);
  return { id, label: game.label };
});

handleApp('nimbo:game:stop', (_event, id) => {
  const child = gameWatches.get(id);
  if (!child) return;
  gameWatches.delete(id);
  child.stdin.end();
  setTimeout(() => child.kill(), 1500).unref();
});

app.on('before-quit', () => stopHelpers());

// ---------- Atualização automática ----------
// O app instalado confere o último Release do GitHub ao abrir e a cada 6 horas e baixa a versão
// nova em segundo plano, mostrando o progresso no próprio Nimbo. Ao clicar em atualizar, encerra
// tudo o que poderia segurar arquivos do app (o capturador nativo roda de dentro da pasta do app;
// se ele continuar aberto, o instalador não consegue trocar os arquivos e o app volta na versão
// antiga), instala sem janela e reabre sozinho. A caixa do Windows fica só de reserva.
let updater = null;
let updateReady = null;
let updateWatcher = null;

const UPDATE_LOG = () => path.join(app.getPath('userData'), 'nimbo-update.log');
function logUpdate(message) {
  try {
    require('fs').appendFileSync(UPDATE_LOG(), `${new Date().toISOString()} ${app.getVersion()} ${message}\n`);
  } catch {
    // Sem registro: segue sem ele.
  }
}

function stopHelpers() {
  for (const child of [...audioSessions.values(), ...gameWatches.values()]) child.kill();
  audioSessions.clear();
  gameWatches.clear();
}

function installUpdate() {
  if (!updater || !updateReady) return false;
  logUpdate(`instalando ${updateReady.version}`);
  stopHelpers();
  // Silenciosa (sem a janela do instalador) e reabrindo o app no fim.
  setTimeout(() => updater.quitAndInstall(true, true), 300);
  return true;
}

handleApp('nimbo:update:watch', (event) => {
  updateWatcher = event.sender;
  return updateReady;
});
handleApp('nimbo:update:install', () => installUpdate());

function setupAutoUpdate() {
  // NIMBO_UPDATE_URL aponta para outro servidor de atualização (testes do ciclo completo).
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  if (process.env.NIMBO_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.NIMBO_UPDATE_URL });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => {
    console.warn('[nimbo] atualização:', e?.message || e);
    logUpdate('erro: ' + (e?.message || e));
  });
  autoUpdater.on('update-available', (info) => logUpdate(`disponível ${info.version}`));
  autoUpdater.on('download-progress', (p) => {
    if (updateWatcher && !updateWatcher.isDestroyed())
      updateWatcher.send('nimbo:update:progress', Math.round(p.percent || 0));
  });
  let asked = false;
  autoUpdater.on('update-downloaded', async (info) => {
    updateReady = { version: info.version };
    logUpdate(`baixada ${info.version}`);
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
    if (response === 0) installUpdate();
  });
  logUpdate('aberto');
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
      pendingGame = selected.game ? { hwnd: selected.game, label: selected.label } : null;
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
      backgroundThrottling: false,
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
