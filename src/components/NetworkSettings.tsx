import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Trash2, Wifi } from 'lucide-react';
import { removeTurn, saveTurn, watchTurn, type TurnConfig } from '../community';
import { testTurn } from '../live/room';
import { errorMessage } from '../lib/errors';

// Lê a resposta do "generate-ice-servers" da Cloudflare (ou de outro serviço no mesmo formato) e
// fica só com o servidor TURN. A porta 53 é bloqueada pelos navegadores e fica de fora.
function parseResponse(text: string): Omit<TurnConfig, 'updatedAt'> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Isso não parece a resposta da Cloudflare. Cole o texto inteiro, começando com {.');
  }
  const servers = ((data as { iceServers?: unknown }).iceServers ?? data) as Array<{
    urls?: string | string[];
    username?: string;
    credential?: string;
  }>;
  const turn = (Array.isArray(servers) ? servers : [servers]).find((s) => s?.username && s?.credential);
  if (!turn) throw new Error('Não achei usuário e senha do TURN nesse texto.');
  const urls = (Array.isArray(turn.urls) ? turn.urls : [turn.urls || ''])
    .filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u))
    .join(',');
  if (!urls) throw new Error('Não achei endereços turn: nesse texto.');
  return { urls, username: turn.username!, credential: turn.credential! };
}

const DAY = 24 * 60 * 60 * 1000;

// Aba "Rede" (só o proprietário): servidor de retransmissão para quem não consegue conexão direta.
export function NetworkSettings() {
  const [current, setCurrent] = useState<TurnConfig | null>(null);
  const [text, setText] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => watchTurn(setCurrent), []);

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy('');
    }
  };
  const asServer = (c: Omit<TurnConfig, 'updatedAt'>): RTCIceServer => ({
    urls: c.urls.split(','),
    username: c.username,
    credential: c.credential,
  });
  const left = current?.expiresAt ? Math.ceil((current.expiresAt - Date.now()) / DAY) : null;

  return (
    <div className="admin-list network-settings">
      <p className="muted">
        Quando a rede de alguém não deixa conexão direta, a live passa por este
        servidor. Ele só é usado nesses casos; o resto continua direto.
      </p>
      <div className="admin-row">
        <Wifi size={18} />
        <div className="admin-row-text">
          <strong>{current ? 'Servidor de retransmissão configurado' : 'Nenhum servidor configurado'}</strong>
          <small className="muted">
            {current
              ? left === null
                ? 'Sem data de validade informada.'
                : left > 0
                  ? `Vale por mais ${left} ${left === 1 ? 'dia' : 'dias'}. Gere uma nova antes de vencer.`
                  : 'Venceu: gere uma credencial nova e cole abaixo.'
              : 'Cole abaixo a credencial gerada na Cloudflare.'}
          </small>
        </div>
        {current && (
          <>
            <button
              className="button ghost small"
              disabled={busy !== ''}
              onClick={() =>
                void run('test-current', async () => {
                  const { works } = await testTurn([asServer(current)]);
                  if (!works) throw new Error('O servidor não respondeu. A credencial pode ter vencido.');
                  return 'Funcionando: o servidor respondeu.';
                })
              }
            >
              {busy === 'test-current' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Testar
            </button>
            <button
              className="icon-button danger"
              title="Remover servidor"
              aria-label="Remover servidor"
              disabled={busy !== ''}
              onClick={() => void run('remove', async () => (await removeTurn(), 'Servidor removido.'))}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
      <label className="field">
        <span>Credencial da Cloudflare (resposta do comando)</span>
        <textarea
          rows={6}
          value={text}
          spellCheck={false}
          placeholder='{"iceServers":[...]}'
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className="field inline">
        <span>Validade que você pediu no comando (dias)</span>
        <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 30)} />
      </label>
      <button
        className="button primary align-start"
        disabled={busy !== '' || !text.trim()}
        onClick={() =>
          void run('save', async () => {
            const parsed = parseResponse(text);
            // Testa antes de salvar: uma credencial errada atrapalharia todo mundo.
            const { works } = await testTurn([asServer(parsed)]);
            if (!works) throw new Error('O servidor não respondeu com essa credencial. Confira se colou tudo.');
            await saveTurn({ ...parsed, expiresAt: Date.now() + days * DAY });
            setText('');
            return 'Salvo e testado. Quem não consegue conexão direta já passa a usar o servidor ao entrar no canal.';
          })
        }
      >
        {busy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Testar e salvar
      </button>
      {message && <p className={message.ok ? 'field-ok' : 'field-error'}>{message.text}</p>}
      <small className="muted">
        A credencial fica guardada no Firebase, visível só para membros aprovados (o app precisa dela para
        conectar). A chave da sua conta Cloudflare nunca vem para cá.
      </small>
    </div>
  );
}
