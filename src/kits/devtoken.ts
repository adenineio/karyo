// The page's key to Karyo's local server (docs/KITS.md "The local server"). The dev server makes a random token when it
// starts and puts it in every page it serves (`<meta name="karyo-token">`, vite.config.ts); requests that change
// something (a splice saved or deleted, the team layout, trust) must carry it (`x-karyo-token`), and must come from the
// server's own origin (src/kits/devserver.ts). This module hands the token to the page's own requests to `/__karyo/…`,
// so the views that save things (the board, Splice) need no change. A kit script runs in a sealed frame with another
// (opaque) origin: it never sees this page, its token or its fetch.

export const TOKEN_HEADER = 'x-karyo-token';

/** The token the page was served with, or null (a built site, no dev server). */
export function devToken(): string | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLMetaElement>('meta[name="karyo-token"]')?.content || null;
}

/** Is `url` one of the dev server's own endpoints, on this page's origin? */
export function isKaryoEndpoint(url: string | URL): boolean {
  try { const u = new URL(String(url), location.href); return u.origin === location.origin && u.pathname.startsWith('/__karyo/'); } catch { return false; }
}

let installed = false;
/** Add the token to this page's own requests to `/__karyo/…` (once per page; a page without a token is left alone). */
export function installDevToken() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const token = devToken();
  if (!token) return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    if (!isKaryoEndpoint(url)) return orig(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, token);
    return orig(input, { ...init, headers });
  };
}
