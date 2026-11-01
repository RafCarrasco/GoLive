// Traduz erros do Firebase e do navegador para mensagens curtas, sem jargão técnico.
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code || '';
  const name = (e as { name?: string })?.name || '';
  if (/permission[_ ]denied/i.test(raw + code)) return 'Você não tem permissão para isso.';
  if (name === 'NotAllowedError') return 'Permissão de captura negada.';
  if (name === 'NotFoundError') return 'Nenhum dispositivo de captura encontrado.';
  if (name === 'NotReadableError') return 'O dispositivo está em uso por outro aplicativo.';
  if (name === 'AbortError') return 'Captura cancelada.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request')
    return 'Login cancelado.';
  if (code === 'auth/popup-blocked')
    return 'O navegador bloqueou a janela de login. Permita pop-ups e tente de novo.';
  if (code === 'auth/network-request-failed') return 'Sem conexão com a internet.';
  return raw;
}
