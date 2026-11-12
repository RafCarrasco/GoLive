// Codificação pela placa de vídeo. O padrão do WebRTC (VP8) é codificado por software: disputa CPU
// com o jogo e, em cena pesada, derruba a resolução. Quando a máquina tem codificador H.264 por
// hardware (NVIDIA, Intel, AMD), o envio passa a preferi-lo. Medido em 11/11/2026, 1080p com muito
// movimento a 8 Mbps: VP8 caiu para 480x270; H.264 por hardware segurou 1280x720.

// Placas NVIDIA antigas aceitam poucas sessões de codificação ao mesmo tempo (3 nos drivers mais
// velhos). Cada amigo que assiste usa uma; acima disto, os próximos ficam no VP8.
export const MAX_HARDWARE_SENDERS = 3;

let probe: Promise<boolean> | null = null;

const CACHE = 'nimbo.hw264';
const WEEK = 7 * 24 * 60 * 60 * 1000;

// Só dá para saber se o H.264 é mesmo por hardware codificando de verdade: testa com um vídeo
// sintético em conexão local (nada sai da máquina) e guarda a resposta por uma semana.
// Chamar com uma captura já ativa: sem ela o navegador esconde qual codificador está em uso.
export function hardwareH264(): Promise<boolean> {
  return (probe ??= (async () => {
    try {
      if (localStorage.getItem('nimbo.hw') === '0') return false;
      const [value, at] = (localStorage.getItem(CACHE) || '').split(':');
      if (value && Date.now() - Number(at) < WEEK) return value === '1';
    } catch {
      // sem localStorage: testa sempre
    }
    const answer = await run().catch(() => null);
    if (answer === null) {
      probe = null; // não deu para saber agora: tenta de novo na próxima live
      return false;
    }
    try {
      localStorage.setItem(CACHE, `${answer ? 1 : 0}:${Date.now()}`);
    } catch {
      // segue sem guardar
    }
    return answer;
  })());
}

const h264 = () =>
  (RTCRtpSender.getCapabilities?.('video')?.codecs || []).filter((c) => c.mimeType.toLowerCase() === 'video/h264');

// Põe o H.264 na frente da lista de codecs deste envio. Chamar antes da negociação.
export function preferH264(transceiver: RTCRtpTransceiver) {
  const all = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
  const first = h264();
  if (!first.length || !transceiver.setCodecPreferences) return false;
  try {
    transceiver.setCodecPreferences([...first, ...all.filter((c) => !first.includes(c))]);
    return true;
  } catch {
    return false;
  }
}

// true/false = resposta medida; null = o navegador não informou o codificador.
async function run(): Promise<boolean | null> {
  if (!h264().length) return false;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream) return false;
  let frame = 0;
  const draw = setInterval(() => {
    ctx.fillStyle = `hsl(${(frame * 7) % 360} 60% 40%)`;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.fillRect((frame * 23) % 1200, (frame * 11) % 640, 80, 80);
    frame++;
  }, 33);
  const stream = canvas.captureStream(30);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
    const transceiver = a.addTransceiver(stream.getVideoTracks()[0], {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: 1_500_000 }],
    });
    if (!preferH264(transceiver)) return false;
    let seen: boolean | null = null;
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    // O codificador por hardware leva um instante para assumir; espera até 4 s por quadros dele.
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 250));
      (await transceiver.sender.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.framesEncoded > 5 && typeof r.powerEfficientEncoder === 'boolean')
          seen = r.powerEfficientEncoder;
      });
      if (seen === true) return true;
      if (seen === false && i >= 8) return false;
    }
    return seen;
  } finally {
    clearInterval(draw);
    stream.getTracks().forEach((t) => t.stop());
    a.close();
    b.close();
  }
}
