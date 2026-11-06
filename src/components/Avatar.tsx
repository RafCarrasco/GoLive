import { useRef, useState } from 'react';
import { ImageUp, LoaderCircle, Trash2 } from 'lucide-react';
import { auth } from '../firebase';
import { setAvatar } from '../community';
import { errorMessage } from '../lib/errors';

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

// Recorta o centro em quadrado, reduz para 128x128 e comprime até caber no limite das regras.
async function shrink(file: File) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    let data = canvas.toDataURL('image/webp', quality);
    // Sem suporte a WebP o navegador devolve PNG: usa JPEG.
    if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= LIMIT) return data;
  }
  throw new Error('Não deu para deixar a imagem pequena o bastante. Tente outra.');
}

// Trocar a foto no "Seu perfil": enviar uma imagem, usar a do Google ou remover.
export function AvatarPicker({ uid, name, photo }: { uid: string; name: string; photo?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
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
        <small className="muted">Todos do Nimbo veem sua foto. Ela é reduzida para um quadrado pequeno.</small>
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
          if (file) void run(async () => setAvatar(uid, await shrink(file)));
        }}
      />
    </div>
  );
}
