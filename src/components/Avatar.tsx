import { useEffect, useRef, useState } from 'react';
import { ImageUp, LoaderCircle, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { auth } from '../firebase';
import { setAvatar } from '../community';
import { errorMessage } from '../lib/errors';
import { Modal } from '../ui/Modal';

// Foto de perfil, ou a inicial do nome quando a pessoa não colocou foto.
export function Avatar({ photo, name, small }: { photo?: string; name: string; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const className = 'avatar' + (small ? ' small' : '');
  if (photo && !broken)
    return (
      <img
        className={className + ' photo'}
        src={photo}
        alt=""
        // A foto do Google só carrega sem o cabeçalho de origem.
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  return <span className={className}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}

const SIZE = 128;
const LIMIT = 22000;
// Lado da área de recorte na tela, em pixels.
const VIEW = 280;
const MAX_ZOOM = 4;

// Comprime o recorte até caber no limite das regras do banco.
function encode(canvas: HTMLCanvasElement) {
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    let data = canvas.toDataURL('image/webp', quality);
    // Sem suporte a WebP o navegador devolve PNG: usa JPEG.
    if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= LIMIT) return data;
  }
  throw new Error('Não deu para deixar a imagem pequena o bastante. Tente outra.');
}

// Janela "Editar imagem", no estilo do Discord: arrastar para enquadrar, zoom na barra ou na roda
// do mouse, e só o que está dentro do círculo vira a foto.
function AvatarCropper({
  image,
  onApply,
  onCancel,
}: {
  image: HTMLImageElement;
  onApply: (data: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);

  // Escala que faz a imagem cobrir o quadrado inteiro no zoom 1.
  const cover = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight);
  const scale = cover * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  // A imagem nunca deixa sobrar espaço vazio dentro da área de recorte.
  const clamp = (o: { x: number; y: number }, w = width, h = height) => ({
    x: Math.max(-(w - VIEW) / 2, Math.min((w - VIEW) / 2, o.x)),
    y: Math.max(-(h - VIEW) / 2, Math.min((h - VIEW) / 2, o.y)),
  });
  const changeZoom = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    const s = cover * z;
    setZoom(z);
    setOffset((o) => clamp({ x: (o.x * z) / zoom, y: (o.y * z) / zoom }, image.naturalWidth * s, image.naturalHeight * s));
  };

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      changeZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const apply = async () => {
    setBusy(true);
    setMessage('');
    try {
      const left = VIEW / 2 - width / 2 + offset.x;
      const top = VIEW / 2 - height / 2 + offset.y;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, SIZE, SIZE);
      await onApply(encode(canvas));
    } catch (e) {
      setMessage(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Editar imagem"
      kicker="FOTO DE PERFIL"
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button className="button ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button className="button primary" onClick={() => void apply()} disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            Aplicar
          </button>
        </>
      }
    >
      <div
        ref={area}
        className="cropper"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOffset(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          style={{
            width,
            height,
            left: VIEW / 2 - width / 2 + offset.x,
            top: VIEW / 2 - height / 2 + offset.y,
          }}
        />
        <div className="cropper-mask" />
      </div>
      <div className="cropper-zoom">
        <ZoomOut size={16} aria-hidden />
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label="Zoom"
          onChange={(e) => changeZoom(Number(e.target.value))}
        />
        <ZoomIn size={16} aria-hidden />
      </div>
      <small className="muted cropper-hint">Arraste para enquadrar. Só o que está dentro do círculo aparece.</small>
      {message && <p className="field-error">{message}</p>}
    </Modal>
  );
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não deu para abrir essa imagem. Tente um JPG ou PNG.'));
    };
    image.src = url;
  });
}

// Trocar a foto no "Seu perfil": enviar uma imagem (com recorte), usar a do Google ou remover.
export function AvatarPicker({ uid, name, photo }: { uid: string; name: string; photo?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<HTMLImageElement | null>(null);
  const googlePhoto = auth.currentUser?.photoURL?.startsWith('https://lh3.googleusercontent.com/')
    ? auth.currentUser.photoURL.replace(/=s\d+(-c)?$/, '') + '=s128-c'
    : '';
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const closeEditor = () => {
    if (editing) URL.revokeObjectURL(editing.src);
    setEditing(null);
  };
  return (
    <div className="avatar-picker">
      <div className="avatar-preview">
        <Avatar photo={photo} name={name} />
        {busy && <LoaderCircle size={22} className="spin" />}
      </div>
      <div className="avatar-actions">
        <button className="button ghost small" disabled={busy} onClick={() => input.current?.click()}>
          <ImageUp size={15} /> {photo ? 'Trocar foto' : 'Escolher foto'}
        </button>
        {googlePhoto && photo !== googlePhoto && (
          <button className="button ghost small" disabled={busy} onClick={() => void run(() => setAvatar(uid, googlePhoto))}>
            Usar foto do Google
          </button>
        )}
        {photo && (
          <button className="button ghost small" disabled={busy} onClick={() => void run(() => setAvatar(uid, null))}>
            <Trash2 size={15} /> Remover
          </button>
        )}
        <small className="muted">Todos do Nimbo veem sua foto.</small>
        {message && <p className="field-error">{message}</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void run(async () => setEditing(await loadImage(file)));
        }}
      />
      {editing && (
        <AvatarCropper
          image={editing}
          onCancel={closeEditor}
          onApply={async (data) => {
            await setAvatar(uid, data);
            closeEditor();
          }}
        />
      )}
    </div>
  );
}
