# Nimbo para Windows

Janela própria que abre o Nimbo publicado: atualizações do site chegam sem novo executável. O app
acrescenta o que o navegador não faz bem:

- **Seletor de tela ou aplicativo** com miniaturas (`capture-picker.html`).
- **Áudio sem eco**: `native/NimboAudio.cs` usa a captura de áudio por processo do Windows (10 2004+).
  Tela inteira transmite todo o som do PC menos o próprio Nimbo; um aplicativo transmite só o som dele.
- **Login do Google pelo navegador do sistema** (o Google bloqueia login dentro de apps): o app abre
  `/desktop-login` com uma porta local e um código de uso único, e a página devolve a credencial.

## Gerar o executável (local)

```powershell
npm run desktop:pack
```

Saída: `release/Nimbo-Portable.exe` (sem instalador, não assinado: o SmartScreen avisa na primeira vez).
O capturador de áudio é compilado com o `csc.exe` que já vem no Windows. `npm run desktop:icon`
regenera `icon.ico` a partir de `public/nimbo-mascot.svg`.

## Testar com os emuladores

```powershell
$env:NIMBO_URL='http://localhost:5173'; $env:NIMBO_LOGIN_PRINT='1'; npm run desktop:dev
```

O link de login sai no terminal; abra-o com `&devUser=nome` para entrar com uma conta fictícia.

## Limites

Jogos em tela cheia exclusiva podem aparecer pretos: use janela sem bordas.
