import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Trash2, Wifi } from 'lucide-react';
import { removeTurn, saveTurn, setNetAdmin, usageMonth, watchTurn, watchTurnUsage, type TurnConfig } from '../community';
import type { CommunityData } from '../hooks/useCommunity';
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

const DEFAULT_LIMIT_GB = 800;
const gb = (bytes: number) => (bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 0);

// Aba "Rede" (proprietário e quem ele liberar): servidor de retransmissão para quem não consegue
// conexão direta, com trava de gasto mensal.
export function NetworkSettings({ uid, owner, data }: { uid: string; owner: boolean; data: CommunityData }) {
  const [current, setCurrent] = useState<TurnConfig | null>(null);
  const [usage, setUsage] = useState(0);
  const [limitGb, setLimitGb] = useState(DEFAULT_LIMIT_GB);
  const [text, setText] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => watchTurn(setCurrent), []);
  useEffect(() => watchTurnUsage(setUsage), []);
  useEffect(() => {
    if (current?.monthlyLimitGb) setLimitGb(current.monthlyLimitGb);
  }, [current?.monthlyLimitGb]);
  const capped = Boolean(current?.monthlyLimitGb) && usage >= (current?.monthlyLimitGb || 0) * 1e9;

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
      <div className="admin-row">
        <div className="admin-row-text">
          <strong>
            Uso em {usageMonth()}: {gb(usage)} GB de {current?.monthlyLimitGb || limitGb} GB
          </strong>
          <small className="muted">
            {capped
              ? 'Limite atingido: o servidor está desligado até o mês virar. Ninguém paga nada além do grátis.'
              : 'Ao chegar no limite, o Nimbo para de usar o servidor até o mês virar. Os 1.000 GB grátis da Cloudflare ficam de folga.'}
          </small>
        </div>
      </div>
      <label className="field inline">
        <span>Limite mensal (GB)</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={limitGb}
          onChange={(e) => setLimitGb(Math.max(1, Math.min(1000, Number(e.target.value) || DEFAULT_LIMIT_GB)))}
        />
      </label>
      {current && current.monthlyLimitGb !== limitGb && (
        <button
          className="button ghost small align-start"
          disabled={busy !== ''}
          onClick={() =>
            void run('limit', async () => {
              const { updatedAt: _ignored, ...rest } = current;
              await saveTurn({ ...rest, monthlyLimitGb: limitGb });
              return `Limite salvo: ${limitGb} GB por mês.`;
            })
          }
        >
          Salvar limite
        </button>
      )}
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
            await saveTurn({ ...parsed, expiresAt: Date.now() + days * DAY, monthlyLimitGb: limitGb });
            setText('');
            return 'Salvo e testado. Quem não consegue conexão direta já passa a usar o servidor ao entrar no canal.';
          })
        }
      >
        {busy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Testar e salvar
      </button>
      {message && <p className={message.ok ? 'field-ok' : 'field-error'}>{message.text}</p>}
      {owner && (
        <div className="net-admins">
          <strong>Quem pode configurar a rede</strong>
          <small className="muted">Além de você. Quem estiver marcado vê esta aba e troca a credencial.</small>
          <div className="role-chips">
            {Object.entries(data.profiles)
              .filter(([id]) => id !== uid)
              .sort((a, b) => a[1].displayName.localeCompare(b[1].displayName))
              .map(([id, profile]) => {
                const on = Boolean(data.netAdmins[id]);
                return (
                  <button
                    key={id}
                    className={'role-chip' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={busy !== ''}
                    onClick={() =>
                      void run('net:' + id, async () => {
                        await setNetAdmin(id, !on);
                        return on ? `${profile.displayName} não configura mais a rede.` : `${profile.displayName} agora pode configurar a rede.`;
                      })
                    }
                  >
                    <span className="role-dot" />
                    {profile.displayName}
                  </button>
                );
              })}
          </div>
        </div>
      )}
      <small className="muted">
        A credencial fica guardada no Firebase, visível só para membros aprovados (o app precisa dela para
        conectar). A chave da sua conta Cloudflare nunca vem para cá.
      </small>
    </div>
  );
}
