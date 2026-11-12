import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  kicker,
  onClose,
  children,
  footer,
  size = 'md',
  className = '',
}: {
  title: string;
  kicker?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className={`modal modal-${size} ${className}`.trimEnd()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            {kicker && <span className="kicker">{kicker}</span>}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

// Substitui window.confirm / window.prompt por modais próprios com API de Promise.
type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean };
type PromptOptions = {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  validate?: (value: string) => string;
};
type DialogApi = {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
};
type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => setPending({ kind: 'prompt', options, resolve })),
    [],
  );
  const api = useRef<DialogApi>({ confirm, prompt }).current;
  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending?.kind === 'confirm' && (
        <ConfirmDialog
          options={pending.options}
          done={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
      {pending?.kind === 'prompt' && (
        <PromptDialog
          options={pending.options}
          done={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
    </DialogContext.Provider>
  );
}

function ConfirmDialog({ options, done }: { options: ConfirmOptions; done: (v: boolean) => void }) {
  return (
    <Modal
      title={options.title}
      size="sm"
      onClose={() => done(false)}
      footer={
        <>
          <button className="button ghost" onClick={() => done(false)}>
            Cancelar
          </button>
          <button
            className={'button ' + (options.danger ? 'danger' : 'primary')}
            autoFocus
            onClick={() => done(true)}
          >
            {options.confirmLabel || 'Confirmar'}
          </button>
        </>
      }
    >
      <p className="muted">{options.message}</p>
    </Modal>
  );
}

function PromptDialog({ options, done }: { options: PromptOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(options.initial || '');
  const [error, setError] = useState('');
  const submit = () => {
    const invalid = options.validate?.(value) || '';
    if (invalid) return setError(invalid);
    done(value.trim());
  };
  return (
    <Modal
      title={options.title}
      size="sm"
      onClose={() => done(null)}
      footer={
        <>
          <button className="button ghost" onClick={() => done(null)}>
            Cancelar
          </button>
          <button className="button primary" onClick={submit}>
            {options.confirmLabel || 'Salvar'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>{options.label}</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
          />
        </label>
        {error && <p className="field-error">{error}</p>}
      </form>
    </Modal>
  );
}

export function useDialogs() {
  const api = useContext(DialogContext);
  if (!api) throw Error('useDialogs fora do DialogProvider');
  return api;
}
