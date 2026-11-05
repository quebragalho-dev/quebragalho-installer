// Cliente HTTP do gateway QG. Erros nunca incluem chave, URL nem corpo do provedor.
import { QgError, readJsonBounded } from './util.mjs';
import { parseCatalog } from './catalog.mjs';

export const DEFAULT_BASE = 'https://api.quebragalho.dev';
export const DEFAULT_AUTH_BASE = 'https://app.quebragalho.dev/api/cli/v1';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function assertSecureUrl(url, label) {
  if (url.username || url.password || url.search || url.hash) throw new QgError(`${label} não pode conter credenciais, query ou fragmento.`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) throw new QgError('Use HTTPS (HTTP somente em loopback local).');
}

// Aceita a raiz ou o sufixo /v1 copiado do painel do gateway.
export function normalizeBase(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new QgError('URL base inválida.'); }
  assertSecureUrl(url, 'URL base');
  return url.href.replace(/\/$/, '').replace(/\/v1$/, '');
}

function retryAfterSeconds(response) {
  const seconds = Number.parseInt(response.headers?.get?.('retry-after') ?? '', 10);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : null;
}

function httpError(response) {
  if (response.status === 401 || response.status === 403) return new QgError(`Chave recusada pelo gateway (HTTP ${response.status}). Rode quebragalho login.`);
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response);
    return new QgError(`Limite de consultas atingido (HTTP 429).${seconds === null ? '' : ` Tente de novo em ${seconds} s.`}`);
  }
  return new QgError(`Gateway respondeu HTTP ${response.status}.`);
}

// Devolve a Response bruta: o chamador decide o que fazer com o status.
export async function gatewayFetch(ctx, base, key, path, { method = 'GET', query, timeoutMs = 15000 } = {}) {
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const headers = { 'anthropic-version': '2023-06-01' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  try {
    return await ctx.fetch(url.href, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (error) { throw new QgError(`Não foi possível conectar ao gateway${networkCode(error)}. Confira a URL e a conexão.`); }
}

// Só o código técnico (ETIMEDOUT, TimeoutError...), nunca a mensagem, que pode ter URL ou chave.
export function networkCode(error) {
  const code = [error?.cause?.code, error?.code, error?.name].find(candidate => typeof candidate === 'string');
  return code !== undefined && /^[A-Za-z0-9_]{1,40}$/.test(code) ? ` (${code})` : '';
}

export async function gatewayJson(ctx, base, key, path, options) {
  const response = await gatewayFetch(ctx, base, key, path, options);
  if (!response.ok) throw httpError(response);
  const body = await readJsonBounded(response, 4 << 20);
  if (body === undefined) throw new QgError('Resposta inválida do gateway.');
  return body;
}

export async function fetchCatalog(ctx, base, key) {
  let body;
  try { body = await gatewayJson(ctx, base, key, '/v1/models'); }
  catch (error) { throw error instanceof QgError && error.message.startsWith('Gateway respondeu') ? new QgError(`Catálogo indisponível: ${error.message}`) : error; }
  return parseCatalog(body);
}

export const fetchBalance = (ctx, base, key) => gatewayJson(ctx, base, key, '/v1/balance', { timeoutMs: 8000 });
export const fetchKeyInfo = (ctx, base, key) => gatewayJson(ctx, base, key, '/v1/key');
export const fetchStatus = (ctx, base, key) => gatewayJson(ctx, base, key, '/v1/status');
export const fetchUsage = (ctx, base, key, query) => gatewayJson(ctx, base, key, '/v1/usage', { query: { scope: 'key', ...query } });

// Sonda uma rota com POST de corpo vazio (sem custo): 404 = rota inexistente. null = sem resposta.
export async function probeEndpoint(ctx, base, key, path) {
  try { return (await gatewayFetch(ctx, base, key, path, { method: 'POST', timeoutMs: 8000 })).status; }
  catch { return null; }
}
