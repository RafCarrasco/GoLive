# Backlog do Nimbo

Itens observados em uso real que ainda não foram resolvidos. Mais antigos primeiro.

## Lives

### Mini travada nas outras lives ao abrir ou fechar a própria (relatado em 01/11/2026)
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
