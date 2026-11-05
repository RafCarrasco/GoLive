# Backlog do Nimbo

Itens observados em uso real que ainda não foram resolvidos. Mais antigos primeiro.

## Lives

### ~~Mini travada nas outras lives ao abrir ou fechar a própria~~ (resolvido em 02/11/2026)
Resolvido na linha da ideia abaixo: os envios não são mais desmontados, só trocam de faixa
(`syncSenders` em `src/live/room.ts`), sem renegociar.

Ao iniciar ou encerrar a própria live, as lives dos outros congelam por uma fração de segundo e voltam.

- **Causa provável:** cada início/fim de live adiciona ou para transceivers na `RTCPeerConnection`
  compartilhada com cada pessoa, o que dispara uma renegociação (nova oferta/resposta). Durante a
  renegociação o navegador reajusta jitter buffer e estimativa de banda das outras faixas.
- **Ideia de correção:** negociar uma vez transceivers fixos por tipo (tela e câmera, vídeo e áudio)
  e usar `sender.replaceTrack()` para ligar/desligar, como já é feito no "Trocar tela". Sem
  renegociação, sem travada. Atenção ao `streamId` anunciado (precisa continuar identificando
  tela × câmera para quem assiste).

### Quedas ocasionais na live de um amigo (relatado em 01/11/2026)
Às vezes a live de um amigo cai e volta.

- **Hipóteses:** upload insuficiente (1080p60 pede até ~6 Mbps por espectador), perda de pacotes na
  rede dele, ou reconexão do Firebase (`.info/connected`) que hoje recria todas as conexões.
- **Para investigar:** rodar `nimboDebug()` nos dois lados durante uma queda (rota, bytes, quadros).
- **Ideias:** bitrate adaptativo (baixar `maxBitrate` quando houver perda), aviso discreto de rede
  instável, não recriar as conexões P2P quando só a conexão com o Firebase oscilou.

### ~~Reconexão mais rápida logo depois de entrar no canal~~ (feito na 0.3.9, 04/11/2026)
Ao reabrir o app (por exemplo, depois de atualizar) a pessoa entra no canal com uma sessão nova e a
conexão com quem está transmitindo é refeita do zero. Quando a primeira tentativa não pega, o vigia
de `src/live/room.ts` (`checkMissing`) só reconecta depois de 20 s sem a live chegar, e no máximo uma
vez a cada 45 s; nesse intervalo a live fica em "Conectando". Ideia: nos primeiros ~30 s depois de
entrar no canal, considerar a live presa com ~6 s e permitir a primeira reconexão sem esperar os
45 s; depois disso volta aos tempos atuais (para não ficar reconectando em rede ruim).

## App e atualizações

### ~~Selo "Atualização disponível" no topo~~ (feito na 0.3.4, 02/11/2026)
Quando houver versão nova, mostrar no canto superior direito da barra do topo um selo verde pequeno
com ícone de download e o texto "Atualização disponível". Um clique atualiza sozinho: no app,
reinicia e instala a versão baixada (`desktop.installUpdate`); no site, recarrega a página.

- Reaproveitar a detecção que já existe em `src/components/UpdateBanner.tsx` (app: `watchUpdate`;
  site: `siteUpdateAvailable`). O selo fica visível enquanto a atualização estiver pendente, mesmo
  depois de a pessoa fechar o cartão com "Depois".
- Entra no próximo Release do app (precisa de `nimboDesktop.watchUpdate`, presente a partir do 0.3.2).

### ~~Rodapé só com "Nimbo 0.3.4"~~ (feito na 0.3.5, 04/11/2026)
Tirar o "· app 0.3.4" do rodapé da barra lateral (`src/components/UserPanel.tsx`, `.version-line`):
fica só "Nimbo <versão>". A versão do app continua no título da janela.

### ~~Novidades sincronizadas com a atualização~~ (feito na 0.3.8, 04/11/2026)
Hoje a janela de novidades aparece quando o site carregado tem versão maior que a última vista
(`nimbo.seenVersion`), independente de a pessoa ter clicado em atualizar. O fluxo desejado é:
clicou em atualizar → o app (ou o site) reinicia → abre já mostrando as novidades da versão
nova. Ideia: ao clicar em atualizar, gravar a versão de destino; depois do reinício, mostrar as
novidades dessa versão e só então marcar como vista. Cuidar para site e app chegarem na mesma
versão (o site pode estar à frente do app) e para quem atualiza sem clicar (abriu o app depois).

## Comunidade

### Foto de perfil visível para todos (pedido em 02/11/2026, para pensar depois)
Restrições: sem Firebase Storage para fotos (combinado no handoff) e custo zero (plano Spark).

- **Opção A, foto do Google:** o login já traz `user.photoURL`. Guardar essa URL no perfil
  (`community/profiles/$uid/photo`) e mostrar no lugar da inicial (barra lateral, participantes,
  painel, cartões de live). Sem upload e sem custo. Regra: só `https://` em `*.googleusercontent.com`,
  até ~300 caracteres.
- **Opção B, foto própria:** a pessoa escolhe uma imagem, o navegador recorta em quadrado, reduz
  para 96x96 e converte para WebP (~5 a 8 KB), e o texto em base64 vai para um nó separado
  (`community/avatars/$uid`), lido uma vez e guardado em cache, para não pesar no perfil. Regra:
  dono escreve a própria, começa com `data:image/webp;base64,` e no máximo ~16 KB. Com 20 pessoas
  são ~160 KB por carregamento, bem dentro do Spark (10 GB/mês de download).
- **Sugestão:** A como padrão e B como "Trocar foto" no perfil; sem foto, continua a inicial colorida.
  Moderação: o proprietário pode remover a foto de alguém (regra de escrita para owner).

### Tela do instalador mais bonita (pedido em 04/11/2026, para a próxima atualização do app)
Hoje a instalação e cada atualização mostram a janelinha padrão do NSIS ("Nimbo Setup ·
Installing, please wait..."), em inglês e cinza.

- **Feito na 0.3.8 — atualização sem janela:** chamar `autoUpdater.quitAndInstall(true, true)` (instalação silenciosa
  e reabre o app sozinho). Quem atualiza pelo selo/cartão não vê mais o instalador. É o ganho maior.
- **Primeira instalação:** o instalador de um clique do NSIS quase não deixa mudar o visual. Dá para
  pôr em português (`nsis.installerLanguages: ['pt_BR']`, "Instalando, aguarde...") e trocar ícone e
  cabeçalho. Para uma tela realmente no estilo do Nimbo (roxo, mascote, barra animada), as opções
  são uma página customizada em script NSIS (`nsis.include`) ou trocar o instalador por um próprio
  (um app Electron pequeno que baixa e instala, com a nossa tela). Avaliar custo antes.

