// Compila o capturador de áudio do app (desktop/native/NimboAudio.cs) com o compilador C# que já
// vem no Windows (.NET Framework 4), sem instalar nada.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) {
  console.error('Compilador C# do .NET Framework não encontrado:', csc);
  process.exit(1);
}
mkdirSync('desktop/bin', { recursive: true });
const out = path.join('desktop', 'bin', 'nimbo-audio.exe');
const source = path.join('desktop', 'native', 'NimboAudio.cs');
execFileSync(csc, ['/nologo', '/platform:x64', '/optimize', '/out:' + out, source], { stdio: 'inherit' });
console.log('desktop/bin/nimbo-audio.exe');
