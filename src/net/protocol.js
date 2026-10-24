/** Shared name sanitizer (client + mirror of server rules). */
export const MAX_PLAYERS = 30;
export const NAME_KEY = 'aftershock-name';
export const CLIENT_ID_KEY = 'aftershock-client-id';

export function sanitizeName(raw) {
  let s = String(raw ?? '').trim().slice(0, 16);
  s = s.replace(/[^\p{L}\p{N}_\- .]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = '';
  return s.slice(0, 16);
}

export function getOrCreateClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (id && /^[a-f0-9]{8,24}$/i.test(id)) return id;
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return Math.random().toString(16).slice(2, 14);
  }
}

/** HTTP /health endpoint of the same room server the WebSocket uses. */
export function healthUrl() {
  const u = wsUrl().replace(/^ws/, 'http').replace(/\/+$/, '');
  return `${u}/health`;
}

export function wsUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('ws')) return params.get('ws');
  if (import.meta.env?.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Direct dev/preview. Room server is 19090 on this Spark.
  // Any other port uses the /ws proxy on the page host.
  if (location.port === '19078' || location.port === '19079') {
    return `${proto}//${location.hostname}:19090`;
  }
  return `${proto}//${location.host}/ws`;
}
