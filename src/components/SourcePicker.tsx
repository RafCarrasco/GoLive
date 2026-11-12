// Seletor do que transmitir no app em Rust. No Electron isso era uma janela separada do app; aqui é
// um modal da própria página, que pede a lista, as miniaturas e os ícones ao app pela ponte.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppWindow, Check, LoaderCircle, Monitor, Search } from 'lucide-react';
import type { NativeMedia, NativeSource, Result } from '../desktop';
import { Modal } from '../ui/Modal';

type Kind = NativeSource['kind'];
type PickerMedia = Pick<NativeMedia, 'sources' | 'thumbnail' | 'icon'>;

// Última escolha de cada aba, só neste computador: quem transmite o mesmo jogo toda noite abre o
// seletor com ele já marcado e só aperta Enter. O id muda a cada abertura, então guarda nome e app.
const LAST_KEY = 'nimbo.source';
type Last = { kind?: Kind } & Partial<Record<Kind, { title: string; app: string }>>;
function loadLast(): Last {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    return saved && typeof saved === 'object' ? (saved as Last) : {};
  } catch {
    return {};
  }
}
function saveLast(source: NativeSource) {
  try {
    const choice = { title: source.title, app: source.app };
    const next: Last = { ...loadLast(), kind: source.kind, [source.kind]: choice };
    localStorage.setItem(LAST_KEY, JSON.stringify(next));
  } catch {
    // Preferência local apenas; segue sem persistir.
  }
}

const REFRESH_MS = 2000;
// Capturar miniatura custa para o app: poucas por vez, e nenhuma segura a fila para sempre.
const THUMBS_AT_ONCE = 4;
const IMAGE_MAX_MS = 8000;

// Imagem pedida ao app; qualquer falha ou demora vira "sem imagem".
async function fetchImage(call: () => Promise<Result<string | null>> | undefined) {
  try {
    const late = new Promise<undefined>((resolve) => setTimeout(resolve, IMAGE_MAX_MS));
    const result = await Promise.race([call(), late]);
    return result?.ok ? result.value : null;
  } catch {
    return null;
  }
}

// undefined = ainda carregando; null = o app não conseguiu.
type Art = { thumb?: string | null; icon?: string | null };

// Miniaturas e ícones chegam depois da lista, cada um no seu tempo, e ficam guardados enquanto o
// seletor está aberto (a lista se renova a cada 2 s sem pedir tudo de novo).
function useSourceArt(media: PickerMedia) {
  const [art, setArt] = useState<Record<string, Art>>({});
  const work = useRef({ asked: new Set<string>(), waiting: [] as string[], running: 0, alive: true }).current;
  useEffect(() => {
    work.alive = true;
    return () => {
      work.alive = false;
    };
  }, [work]);

  const request = useCallback(
    (source: NativeSource) => {
      const put = (id: string, key: keyof Art, value: string | null) => {
        if (work.alive) setArt((all) => ({ ...all, [id]: { ...all[id], [key]: value } }));
      };
      const pump = () => {
        while (work.running < THUMBS_AT_ONCE && work.waiting.length) {
          const id = work.waiting.shift()!;
          work.running++;
          void fetchImage(() => media.thumbnail?.(id)).then((value) => {
            work.running--;
            put(id, 'thumb', value);
            pump();
          });
        }
      };
      const { id } = source;
      if (!work.asked.has(id)) {
        work.asked.add(id);
        void fetchImage(() => media.icon?.(id)).then((value) => put(id, 'icon', value));
      }
      // Janela que estava minimizada e voltou: pede a miniatura de novo, agora ela existe.
      const thumbKey = `${id}|${source.minimized}`;
      if (work.asked.has(thumbKey)) return;
      work.asked.add(thumbKey);
      work.waiting.push(id);
      pump();
    },
    [media, work],
  );
  return { art, request };
}

function SourceCard({
  source,
  art,
  selected,
  tabbable,
  onSelect,
  onChoose,
  onSeen,
}: {
  source: NativeSource;
  art: Art | undefined;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onChoose: () => void;
  onSeen: (source: NativeSource) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  // Miniatura que o navegador não conseguiu abrir conta como "sem prévia".
  const [broken, setBroken] = useState('');
  // Só pede as imagens quando o cartão chega perto de aparecer na lista.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setSeen(true);
        io.disconnect();
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (seen) onSeen(source);
  }, [seen, source, onSeen]);

  const Fallback = source.kind === 'screen' ? Monitor : AppWindow;
  const thumb = art?.thumb && art.thumb !== broken ? art.thumb : null;
  const loading = art?.thumb === undefined;
  const icon = (size: number) =>
    art?.icon ? <img src={art.icon} alt="" width={size} height={size} /> : <Fallback size={size} aria-hidden />;
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      data-source={source.id}
      tabIndex={tabbable ? 0 : -1}
      className={'source-card' + (selected ? ' on' : '')}
      title={source.title}
      onClick={onSelect}
      onDoubleClick={onChoose}
    >
      <span className={'source-thumb' + (loading ? ' loading' : '')}>
        {thumb ? (
          <img className="source-shot" src={thumb} alt="" onError={() => setBroken(thumb)} />
        ) : (
          !loading && (
            <span className="source-blank">
              {icon(32)}
              <span>Sem prévia</span>
            </span>
          )
        )}
        <span className="source-tags">
          {source.game && <span className="source-tag game">Jogo</span>}
          {source.fullscreen && <span className="source-tag">Tela cheia</span>}
          {source.minimized && <span className="source-tag">Minimizada</span>}
        </span>
        {selected && (
          <span className="source-check" aria-hidden>
            <Check size={14} strokeWidth={3} />
          </span>
        )}
      </span>
      <span className="source-name">
        {icon(16)}
        <span className="source-text">
          <strong>{source.title}</strong>
          {source.app && <small>{source.app}</small>}
        </span>
      </span>
    </button>
  );
}

// Busca sem diferenciar maiúsculas nem acentos.
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function SourcePicker({
  media,
  onDone,
}: {
  media: PickerMedia;
  onDone: (source: NativeSource | null) => void;
}) {
  const last = useRef(loadLast()).current;
  const [kind, setKind] = useState<Kind>(last.kind === 'window' ? 'window' : 'screen');
  // null = primeira lista ainda não chegou.
  const [sources, setSources] = useState<NativeSource[] | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const { art, request } = useSourceArt(media);
  const toolbar = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const reload = useRef(() => {});

  // O que já vem marcado numa aba: a escolha da última vez, ou a tela quando só existe uma.
  const suggest = useCallback(
    (list: NativeSource[], of: Kind) => {
      const options = list.filter((s) => s.kind === of);
      const before = last[of];
      const same = before && options.find((s) => s.title === before.title && s.app === before.app);
      return (same || (of === 'screen' && options.length === 1 ? options[0] : null))?.id ?? null;
    },
    [last],
  );

  // Lista renovada enquanto o seletor está aberto: um jogo aberto agora aparece sem reabrir.
  useEffect(() => {
    let alive = true;
    let busy = false;
    let first = true;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      let failure = '';
      let list: NativeSource[] | null = null;
      try {
        const result = await media.sources!();
        if (result.ok) list = result.value;
        else failure = result.error;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      busy = false;
      if (!alive) return;
      // Falha depois da primeira lista: mantém o que já está na tela e tenta de novo no próximo ciclo.
      if (!list) {
        if (first) setError(failure || 'Sem resposta do app.');
        return;
      }
      const fresh = list;
      setError('');
      // Lista igual não redesenha nada.
      setSources((current) => (current && JSON.stringify(current) === JSON.stringify(fresh) ? current : fresh));
      if (first) setSelectedId(suggest(fresh, kindRef.current));
      first = false;
    };
    reload.current = () => void refresh();
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [media, suggest]);

  // Jogos primeiro; o resto fica na ordem que o app mandou.
  const shown = useMemo(() => {
    const wanted = fold(query.trim());
    const list = (sources || []).filter(
      (s) => s.kind === kind && (!wanted || fold(`${s.title} ${s.app}`).includes(wanted)),
    );
    return [...list.filter((s) => s.game), ...list.filter((s) => !s.game)];
  }, [sources, kind, query]);
  // Só vale o que está à vista: fonte que fechou ou saiu da busca deixa de estar marcada.
  const current = shown.find((s) => s.id === selectedId) || null;
  const count = (of: Kind) => (sources ? sources.filter((s) => s.kind === of).length : null);

  const choose = useCallback(
    (source: NativeSource | null) => {
      if (source) saveLast(source);
      onDone(source);
    },
    [onDone],
  );
  const pickKind = (next: Kind) => {
    setKind(next);
    setQuery('');
    setSelectedId(sources ? suggest(sources, next) : null);
  };

  // Foco: entra no modal ao abrir e, quando a lista chega, vai para o que já está marcado (Enter
  // transmite), para a busca nas janelas ou para o primeiro cartão.
  const ready = sources !== null;
  useEffect(() => {
    const dialog = toolbar.current?.closest<HTMLElement>('.modal');
    // Quem já começou a digitar na busca enquanto a lista carregava fica onde está.
    if (!dialog || (ready && document.activeElement === search.current)) return;
    const marked = dialog.querySelector<HTMLElement>('[data-source][aria-selected="true"]');
    const fallback =
      kindRef.current === 'window' ? search.current : dialog.querySelector<HTMLElement>('[data-source]');
    (ready ? marked || fallback : dialog.querySelector<HTMLElement>('.segmented .on'))?.focus();
  }, [ready]);

  // A janela marcada fechou e levou o foco junto: ele volta para a lista, não fica solto na página.
  useEffect(() => {
    if (document.activeElement !== document.body) return;
    const dialog = toolbar.current?.closest<HTMLElement>('.modal');
    // Sem rolar: quem está passeando pela lista com o mouse não pode ser puxado de volta.
    (dialog?.querySelector<HTMLElement>('[data-source][tabindex="0"]') || search.current)?.focus({
      preventScroll: true,
    });
  }, [shown]);

  // Teclado: Tab não sai do modal, Enter transmite e as setas andam pelos cartões. O Esc é do Modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialog = toolbar.current?.closest<HTMLElement>('.modal');
      if (!dialog) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inside = active && dialog.contains(active) ? active : null;
      if (e.key === 'Tab') {
        const controls = dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input');
        const stops = [...controls].filter((el) => el.tabIndex >= 0 && !el.disabled);
        const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
        if (inside && inside !== edge) return;
        e.preventDefault();
        (e.shiftKey ? stops[stops.length - 1] : stops[0])?.focus();
        return;
      }
      const card = inside?.closest<HTMLElement>('[data-source]');
      if (e.key === 'Enter') {
        // Tecla segurada desde o clique que abriu o seletor não pode confirmar sozinha.
        if (e.repeat || e.isComposing) return;
        // Num cartão, transmite o cartão. Nos outros botões, Enter é o clique normal deles. Na busca,
        // transmite o que está marcado ou o único resultado.
        const target = card
          ? shown.find((s) => s.id === card.dataset.source)
          : inside?.tagName === 'BUTTON'
            ? undefined
            : current || (shown.length === 1 ? shown[0] : undefined);
        if (!target) return;
        e.preventDefault();
        choose(target);
        return;
      }
      if (!card) return;
      const cards = [...dialog.querySelectorAll<HTMLElement>('[data-source]')];
      const at = cards.indexOf(card);
      const columns = cards.filter((c) => c.offsetTop === cards[0].offsetTop).length;
      const steps: Record<string, number> = {
        ArrowLeft: at - 1,
        ArrowRight: at + 1,
        ArrowUp: at - columns,
        ArrowDown: at + columns,
        Home: 0,
        End: cards.length - 1,
      };
      if (!(e.key in steps)) return;
      e.preventDefault();
      const to = cards[steps[e.key]];
      if (!to) return;
      to.focus();
      setSelectedId(to.dataset.source!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, current, choose]);

  const windows = kind === 'window';
  return (
    <Modal
      title="Escolha o que transmitir"
      kicker="LIVE"
      className="source-picker"
      onClose={() => choose(null)}
      footer={
        <>
          <small className="muted source-hint">
            {windows
              ? 'Os jogos abertos aparecem primeiro.'
              : 'Jogo não aparece em Janelas? Escolha a tela onde ele está.'}
          </small>
          <button className="button ghost" onClick={() => choose(null)}>
            Cancelar
          </button>
          <button className="button primary" disabled={!current} onClick={() => choose(current)}>
            Transmitir
          </button>
        </>
      }
    >
      <div className="source-toolbar" ref={toolbar}>
        <div className="segmented">
          {(['screen', 'window'] as const).map((of) => (
            <button
              key={of}
              className={kind === of ? 'on' : ''}
              aria-pressed={kind === of}
              onClick={() => pickKind(of)}
            >
              {of === 'screen' ? 'Telas' : 'Janelas'}
              {count(of) !== null && <span className="source-count">{count(of)}</span>}
            </button>
          ))}
        </div>
        {windows && (
          <label className="source-search">
            <Search size={15} aria-hidden />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Buscar janela ou aplicativo"
              aria-label="Buscar janela ou aplicativo"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
      </div>
      {!sources ? (
        error ? (
          <div className="source-empty" role="alert">
            <strong>Não foi possível listar as telas e janelas.</strong>
            <small className="muted">{error}</small>
            <button className="button ghost" onClick={() => reload.current()}>
              Tentar de novo
            </button>
          </div>
        ) : (
          <div className="source-empty muted">
            <LoaderCircle size={22} className="spin" aria-hidden />
            <span>Procurando telas e janelas…</span>
          </div>
        )
      ) : shown.length === 0 ? (
        <div className="source-empty muted">
          {query.trim() ? (
            <>
              <span>Nenhuma janela com “{query.trim()}”.</span>
              <button
                className="button ghost"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
              >
                Limpar busca
              </button>
            </>
          ) : (
            <span>{windows ? 'Nenhuma janela aberta.' : 'Nenhuma tela encontrada.'}</span>
          )}
        </div>
      ) : (
        <div className="source-grid" role="listbox" aria-label={windows ? 'Janelas' : 'Telas'}>
          {shown.map((source, index) => (
            <SourceCard
              key={source.id}
              source={source}
              art={art[source.id]}
              selected={source.id === current?.id}
              tabbable={current ? source.id === current.id : index === 0}
              onSelect={() => setSelectedId(source.id)}
              onChoose={() => choose(source)}
              onSeen={request}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

// Devolve o foco a quem abriu o seletor. O botão fica desabilitado enquanto a live começa; aí
// espera ele voltar, e só foca se a pessoa não tiver ido para outro lugar nesse meio tempo.
function restoreFocus(opener: HTMLElement | null) {
  if (!opener?.isConnected) return;
  opener.focus();
  if (document.activeElement === opener) return;
  const watch = new MutationObserver(() => {
    if (opener.matches(':disabled')) return;
    watch.disconnect();
    if (document.activeElement === document.body) opener.focus();
  });
  watch.observe(opener, { attributes: true, attributeFilter: ['disabled'] });
  setTimeout(() => watch.disconnect(), 20000);
}

let open: Promise<NativeSource | null> | null = null;

// Abre o seletor e resolve com a fonte escolhida, ou null se a pessoa desistiu. É chamado pela
// captura (live/native.ts), fora da árvore do React, por isso monta a própria raiz.
export function pickNativeSource(media: PickerMedia): Promise<NativeSource | null> {
  open ??= new Promise<NativeSource | null>((resolve) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let closed = false;
    const done = (source: NativeSource | null) => {
      if (closed) return;
      closed = true;
      open = null;
      root.unmount();
      host.remove();
      restoreFocus(opener);
      resolve(source);
    };
    root.render(<SourcePicker media={media} onDone={done} />);
  });
  return open;
}
