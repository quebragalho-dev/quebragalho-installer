// Login por código (RFC 8628), igual ao CLI oficial: internal/qgaccount/device.go.
import { win32 } from 'node:path';
import { QgError, isValidKey, readJsonBounded } from './util.mjs';
import { envValue } from './proc.mjs';
import { assertSecureUrl } from './gateway.mjs';

export const CLIENT_ID = 'quebragalho-cli';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_LIFETIME_MS = 600000;
const MAX_LIFETIME_MS = 3600000;
const POLL_FLOOR_MS = 1000;
const SLOW_DOWN_MS = 5000;
const MAX_RETRY_AFTER_MS = 3600000;
const MAX_INTERVAL_MS = 60000;

export const normalizeAuthBase = raw => {
  let url;
  try { url = new URL(raw); } catch { throw new QgError('URL de autenticação inválida.'); }
  assertSecureUrl(url, 'URL de autenticação');
  return url.href.replace(/\/$/, '');
};

async function postForm(ctx, authBase, path, fields) {
  try {
    return await ctx.fetch(`${authBase}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString() });
  } catch { throw new QgError('Não foi possível conectar ao servidor de login.'); }
}

const readJson = response => readJsonBounded(response);
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

export async function requestDeviceCode(ctx, authBase) {
  const response = await postForm(ctx, authBase, '/auth/device/code', { client_id: CLIENT_ID });
  if (!response.ok) throw new QgError(`O servidor de login recusou o pedido (HTTP ${response.status}).`);
  const body = await readJson(response);
  if (typeof body?.device_code !== 'string' || !body.device_code.trim() || typeof body?.user_code !== 'string' || !body.user_code.trim()) throw new QgError('Resposta de login inválida.');
  return { deviceCode: body.device_code, userCode: body.user_code,
    verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : '',
    verificationUriComplete: typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : '',
    intervalMs: Math.min(positive(body.interval, DEFAULT_INTERVAL_MS / 1000) * 1000, MAX_INTERVAL_MS),
    expiresAt: ctx.now() + Math.min(positive(body.expires_in, DEFAULT_LIFETIME_MS / 1000) * 1000, MAX_LIFETIME_MS) };
}

// Uma consulta: pending | slow | expired | denied | rate (com retryAfterMs) | ok (com key).
export async function pollOnce(ctx, authBase, auth) {
  const response = await postForm(ctx, authBase, '/auth/device/token', { grant_type: GRANT_TYPE, device_code: auth.deviceCode, client_id: CLIENT_ID });
  if (response.status === 429) {
    const seconds = Number.parseInt(response.headers?.get?.('retry-after') ?? '', 10);
    return { state: 'rate', retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0 };
  }
  const body = await readJson(response);
  if (!response.ok) {
    const states = { authorization_pending: 'pending', slow_down: 'slow', expired_token: 'expired', access_denied: 'denied' };
    const state = typeof body?.error === 'string' ? states[body.error] : undefined;
    if (state) return { state };
    throw new QgError(`O servidor de login recusou a consulta (HTTP ${response.status}).`);
  }
  const key = [body?.api_key, body?.key, body?.access_token].find(candidate => typeof candidate === 'string' && candidate.trim())?.trim();
  if (!isValidKey(key)) throw new QgError('Resposta de login sem chave válida.');
  return { state: 'ok', key };
}

// Mesmo laço do CLI oficial: slow_down soma 5 s; 429 espera Retry-After sem passar da expiração.
export async function pollDeviceToken(ctx, authBase, auth, { floorMs = POLL_FLOOR_MS } = {}) {
  let interval = Math.max(auth.intervalMs, floorMs);
  const expired = () => ctx.now() >= auth.expiresAt;
  for (;;) {
    if (expired()) throw new QgError('O código expirou. Rode quebragalho login de novo.');
    await ctx.wait(interval);
    if (expired()) throw new QgError('O código expirou. Rode quebragalho login de novo.');
    const result = await pollOnce(ctx, authBase, auth);
    if (result.state === 'ok') return result.key;
    if (result.state === 'denied') throw new QgError('Login negado no navegador.');
    if (result.state === 'expired') throw new QgError('O código expirou. Rode quebragalho login de novo.');
    if (result.state === 'slow') interval = Math.max(interval + SLOW_DOWN_MS, floorMs);
    if (result.state === 'rate') {
      const remaining = auth.expiresAt - ctx.now();
      if (remaining <= 0) throw new QgError('O código expirou. Rode quebragalho login de novo.');
      await ctx.wait(Math.min(Math.max(result.retryAfterMs, interval), remaining));
    }
  }
}

// Só abre URL https do domínio oficial (ou loopback, se o próprio servidor de login for local).
// Devolve a URL normalizada (é ela que vai ao sistema, nunca a string crua) ou null.
export function isSafeToOpen(raw, { allowLoopback = false } = {}) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    const official = url.hostname === 'quebragalho.dev' || url.hostname.endsWith('.quebragalho.dev');
    const local = allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' && official) || local ? url.href : null;
  } catch { return null; }
}

// Comandos por caminho absoluto no macOS e no Windows; rundll32 sem cmd.exe (o & de uma URL não vira comando).
export function browserCommand(platform, url, env = {}) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] };
  if (platform === 'win32') return { command: win32.join(envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}
