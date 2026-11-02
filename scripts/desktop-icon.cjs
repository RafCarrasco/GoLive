// Gera desktop/icon.ico a partir de public/nimbo-mascot.svg. Rodar com: npx electron scripts/desktop-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'nimbo-mascot.svg'), 'utf8');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await image.decode();
    return ${JSON.stringify(SIZES)}.map((size) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  })()`);
  const images = pngs.map((b64) => Buffer.from(b64, 'base64'));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((png, i) => {
    const size = SIZES[i];
    const entry = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  fs.writeFileSync(path.join(__dirname, '..', 'desktop', 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('desktop/icon.ico', offset, 'bytes');
  app.quit();
});
