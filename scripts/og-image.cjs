// Gera public/og-nimbo.png (1280x640), a imagem de prévia de links do Nimbo (Discord, WhatsApp) e
// do repositório no GitHub. Rodar com: npx electron scripts/og-image.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const icon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'brand', 'nimbo-icon-master-1024.png')).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1280px; height: 640px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(ellipse at 22% 30%, #3b2f8f 0, #171a3d 45%, #0b1020 80%); color: #eef1ff;
    display: flex; align-items: center; gap: 72px; padding: 0 110px; }
  .mascot { width: 360px; height: 360px; flex: none; filter: drop-shadow(0 30px 60px rgba(0,0,0,.45)); }
  .mascot img { width: 100%; height: 100%; }
  .kicker { display: inline-block; padding: 10px 20px; border-radius: 999px; background: rgba(169,148,255,.16);
    border: 1px solid rgba(169,148,255,.45); color: #cfc4ff; font-size: 24px; font-weight: 600; letter-spacing: .5px; }
  h1 { font-size: 150px; font-weight: 800; letter-spacing: -4px; line-height: 1; margin: 26px 0 18px; }
  h1 em { font-style: normal; color: #a994ff; }
  p { font-size: 36px; color: #b4bdd8; line-height: 1.3; }
</style></head><body>
  <div class="mascot"><img src="data:image/png;base64,${icon}"></div>
  <div>
    <span class="kicker">App para Windows</span>
    <h1>Nim<em>bo</em></h1>
    <p>Lives de tela e webcam<br>entre amigos, sem eco.</p>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 640, useContentSize: true, enableLargerThanScreen: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 640 });
  const out = path.join(__dirname, '..', 'public', 'og-nimbo.png');
  fs.writeFileSync(out, image.resize({ width: 1280, height: 640 }).toPNG());
  console.log(out);
  app.quit();
});
