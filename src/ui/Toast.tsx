import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { errorMessage } from '../lib/errors';

type ToastType = 'success' | 'error' | 'info';
type Toast = { id: number; text: string; type: ToastType };
type ToastApi = {
  show: (text: string, type?: ToastType) => void;
  success: (text: string) => void;
  error: (e: unknown) => void;
  info: (text: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);
const icons = { success: CircleCheck, error: CircleAlert, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (text: string, type: ToastType = 'info') => {
      const id = next.current++;
      // Mensagens repetidas substituem a anterior em vez de empilhar.
      setToasts((list) => [...list.filter((t) => t.text !== text).slice(-2), { id, text, type }]);
      setTimeout(() => dismiss(id), type === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (text) => show(text, 'success'),
      error: (e) => show(errorMessage(e), 'error'),
      info: (text) => show(text, 'info'),
    }),
    [show],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icons[t.type];
          return (
            <div key={t.id} className={'toast ' + t.type}>
              <Icon size={18} aria-hidden />
              <span>{t.text}</span>
              <button className="icon-button" aria-label="Fechar aviso" onClick={() => dismiss(t.id)}>
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const api = useContext(ToastContext);
  if (!api) throw Error('useToast fora do ToastProvider');
  return api;
}
