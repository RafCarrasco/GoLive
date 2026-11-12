# Nimbo

Comunidade privada para transmitir e assistir telas e webcams entre amigos. React + TypeScript + Vite,
Firebase (Auth Google, Realtime Database, Hosting — plano Spark) e WebRTC P2P.

Para branches, PRs, testes e publicação, veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Estrutura

| Caminho | Responsabilidade |
|---|---|
| `src/App.tsx` | Fluxo de entrada (login → aprovação → nickname) e composição da tela |
| `src/live/room.ts` | `LiveRoom`: presença no canal, sinalização e conexões WebRTC (sem React) |
| `src/live/capture.ts` | Captura de tela/webcam, bitrate e fonte de teste |
| `src/hooks/` | Autenticação, dados da comunidade, presença dos canais, sala ativa |
| `src/components/` | Sidebar, rodapé do usuário, palco multiview, player, administração, modais |
| `src/ui/` | Toasts e modais reutilizáveis (inclui confirmação e prompt) |
| `src/community.ts` | Leitura/escrita de categorias, canais, perfis, cargos e permissões |
| `scripts/build-rules.mjs` | Gera `database.rules.json` (não edite o JSON à mão) |
| `tests/rules.test.mjs` | Testes das regras de segurança no emulador |

## Desenvolvimento

```powershell
npm install
npm run dev
```

### Testar localmente sem tocar no Firebase real

Requer Java e Firebase CLI. Em um terminal:

```powershell
npm run emulators
```

Em outro:

```powershell
npm run dev:local
```

Abra `http://localhost:5173/?devUser=owner&fakeMedia=1` e, em outras abas, `?devUser=bia&fakeMedia=1` etc.
Cada aba vira uma conta Google fictícia; `fakeMedia` usa um vídeo sintético no lugar da captura.
Depois de abrir as abas, aprove todos com:

```powershell
npm run emulator:approve
```

### Regras de segurança

```powershell
npm run rules:build
npm run test:rules
```

Publique as regras **junto** com o Hosting: o cliente atual lê `rooms/{id}/members|streams|signals/{uid}`
separadamente e depende das regras novas.

```powershell
npm run build
firebase deploy --project golive-ad118 --only hosting,database
```

## Limites conhecidos

- Algumas redes (NAT restritivo, redes corporativas) só conectam por um servidor de retransmissão
  (TURN), configurado na aba **Rede** do painel. Sem ele, a live mostra "Não foi possível conectar".
- Cada espectador recebe uma cópia do vídeo: 1080p60 usa até ~6 Mbps de upload por espectador.
- Áudio de jogos depende do navegador/SO; jogos em tela cheia exclusiva podem não ser capturados.
