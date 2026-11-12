# Nimbo em Rust: plano

Objetivo: o app de Windows deixa de ser Electron e passa a ser Rust, sem perder nada do que o
app atual faz. Este documento diz o que muda, o que ganha e em que ordem.

## O que foi medido (11/11/2026, i5-14600KF + RTX 5070)

| Cenário (1080p, muito movimento, teto de 8 Mbps) | Codificador | Resolução entregue | CPU do app |
|---|---|---|---|
| App atual, padrão (VP8) | software | 480x270 | ~3% |
| App atual com H.264 da placa de vídeo | NVIDIA | 1280x720 | ~3% |

Conclusões:

1. Em máquina forte o CPU não é o gargalo; a qualidade por megabit é. O H.264 pela placa de vídeo
   já entrou no app atual (PR #5).
2. O custo que cresce de verdade é **um codificador por espectador**. O WebRTC do navegador
   codifica o mesmo vídeo de novo para cada amigo que assiste. Com 5 amigos são 5 codificações.
   É isso que pesa em máquina fraca e é isso que só um motor próprio resolve.

## Onde o Rust ganha

| Parte | Hoje (Electron) | Em Rust | Ganho |
|---|---|---|---|
| Codificação | 1 por espectador | **1 para todos** | CPU/GPU não cresce com a plateia |
| Captura | Chromium copia quadros entre processos | Windows Graphics Capture direto na GPU | Menos cópia, menos atraso |
| Áudio do jogo | Programa auxiliar em C# | WASAPI no mesmo processo | Um programa a menos |
| Instalador | ~100 MB | ~10 a 15 MB | Download e atualização rápidos |
| Memória parado | ~250 MB | ~80 MB | |

O que **não** muda: a interface continua sendo HTML/CSS (a mesma do site), desenhada pelo
WebView2 que já vem no Windows. Reescrever botões em Rust não deixaria nada mais rápido e
duplicaria todo o trabalho entre site e app.

## Arquitetura

```
┌──────────────────────── Nimbo.exe (Rust, Tauri 2) ────────────────────────┐
│  WebView2: interface do site (login, canais, assistir lives)              │
│      │  comandos (IPC)                    ▲ eventos                        │
│      ▼                                    │                                │
│  nimbo-media (Rust)                                                        │
│    captura  → Windows Graphics Capture (janela, tela, jogo)                │
│    vídeo    → codificador H.264 da placa (Media Foundation), 1 só          │
│    áudio    → WASAPI process loopback → Opus                               │
│    envio    → WebRTC em Rust (str0m): 1 conexão por espectador,            │
│               todas recebendo os mesmos pacotes já codificados             │
│  janela, seletor de tela, vigia do jogo, atualização, login                │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Quem assiste não muda.** Site, celular e app continuam recebendo WebRTC normal.
- **Sinalização não muda.** A interface continua falando com o Firebase; ela só repassa a
  oferta/resposta e os candidatos ICE para o motor em Rust em vez de para o navegador.
- **Assistir** continua no WebView2 (decodificação pela placa de vídeo já acontece lá).
- **TURN, trava de gasto e regras do banco** continuam os mesmos.

## Por que não deu certo antes

A primeira tentativa (`refactor/nimbo-rust-migration`) reescreveu a interface em Rust/WASM e
deixou a captura por conta do WebView2. O WebView2 não deixa o app escolher a janela nem separar
o áudio do jogo, então CS e Valorant voltariam a falhar. Aqui é o contrário: a interface fica, e
o Rust assume justamente a captura e o envio.

## Etapas

Cada etapa termina com um número medido ou um teste que roda no CI. O Electron continua sendo o
app distribuído até a etapa 7.

| # | Entrega | Pronto quando |
|---|---|---|
| 1 | Captura nativa de tela/janela | Mede quadros por segundo e CPU capturando 1080p60 |
| 2 | Codificação H.264 pela placa, uma só | Gera arquivo .h264 que toca; mede ms por quadro |
| 3 | Envio WebRTC em Rust para 1 navegador | Uma aba do site assiste a tela capturada pelo Rust |
| 4 | Vários espectadores com 1 codificador | 5 abas assistindo; CPU igual ao de 1 |
| 5 | Casca Tauri com a interface do site + ponte de sinalização | Live de ponta a ponta entre duas contas no emulador |
| 6 | Paridade: áudio do jogo, seletor, pausa no Alt+Tab, fim da live ao fechar o jogo, login, atualização automática | Lista de testes do app atual passando no app Rust |
| 7 | Beta lado a lado ("Nimbo Beta") e depois a troca | Amigos usando sem regressão; instalador novo no Release |

## Riscos

- **Controle de banda.** O navegador ajusta a qualidade sozinho; no motor próprio isso é nosso.
  Com um codificador para todos, a qualidade segue o espectador com a pior rede. Saída: dois
  níveis (alto e econômico), cada um com seu codificador.
- **Jogos em tela cheia exclusiva e anticheat.** O Windows Graphics Capture tem os mesmos limites
  do Chromium; não piora, mas também não resolve sozinho.
- **Máquina sem codificador na placa.** Precisa de um codificador por software (OpenH264) de reserva.
- **Troca de app.** Quem tem o Electron instalado precisa migrar. O instalador novo usa o mesmo
  identificador para substituir o antigo sem pedir desinstalação.
