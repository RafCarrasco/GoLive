import { version } from '../../package.json';
import { useEmulators } from '../firebase';

export const SITE_VERSION = version;
// O Electron põe o nome e a versão do app no user agent ("Nimbo/0.3.1"); no navegador fica vazio.
export const APP_VERSION = /\bnimbo\/(\d+\.\d+\.\d+)/i.exec(navigator.userAgent)?.[1] || '';

const bundleOf = (html: string) => /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] || '';

// Compara o bundle carregado com o publicado agora. Só faz sentido no site publicado.
export async function siteUpdateAvailable() {
  if (!import.meta.env.PROD || useEmulators) return false;
  const current = bundleOf(document.querySelector('script[src*="/assets/index-"]')?.outerHTML || '');
  if (!current) return false;
  const response = await fetch('/', { cache: 'no-store' });
  if (!response.ok) return false;
  const published = bundleOf(await response.text());
  return Boolean(published) && published !== current;
}
