// Auxiliares dos testes: contexto simulado (sem rede, sem cofre real) e catálogo de exemplo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEY = 'test-secret-key-0123456789';

export const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers });

// Catálogo no formato real do gateway (05/11/2026), com dois modelos de decisão.
export const model = (id, extra = {}) => ({ id, owned_by: 'qg', display_name: null, context_length: null, max_output_tokens: null,
  capabilities: { tools: null, vision: null, reasoning: null }, description: null, accepts_bonus: false,
  pricing: { currency: 'USD', input: '1.25', output: '10.00', cached_input: '0.125' },
  pricing_brl: { currency: 'BRL', input: '6.8750', output: '55', cached_input: '0.6875' }, offer: null, ...extra });
export const CATALOG = { data: [
  model('gpt-6-luna', { display_name: 'GPT-6 Luna', context_length: 200000, max_output_tokens: 32000,
    capabilities: { tools: true, vision: true, reasoning: true }, offer: { type: 'relampago', discount_percent: 20 } }),
  model('model-a'),
  model('systemone', { type: 'decision', supported_endpoints: ['/v1/systemone', '/v1/decisions'] }),
  model('decisor-2', { supported_endpoints: ['/v1/decisions'] }),
] };

// Roteador de fetch: rotas "MÉTODO /caminho" -> resposta ou função. Registra as chamadas.
export function router(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const route = `${options.method ?? 'GET'} ${pathname}`;
    calls.push({ route, url, options });
    const handler = routes[route];
    if (handler === undefined) return json({ error: 'not found' }, { status: 404 });
    return typeof handler === 'function' ? handler(options, url) : handler.clone();
  };
  return { fetch, calls };
}

export function memoryVault(kind = 'keychain') {
  const items = new Map();
  return { kind, label: 'cofre de teste', items,
    async get(service, account) { return items.get(`${service}/${account}`); },
    async set(service, account, secret) { items.set(`${service}/${account}`, secret); return {}; },
    async remove(service, account) { items.delete(`${service}/${account}`); } };
}

export function makeCtx(overrides = {}) {
  const lines = { out: [], err: [], waits: [] };
  let clock = 1_000_000;
  const ctx = {
    env: { PATH: '' }, platform: 'linux', homedir: () => '/home/teste', isTTY: false,
    fetch: async () => { throw new Error('sem rede nos testes'); }, exec: () => { throw new Error('sem exec'); },
    now: () => clock, wait: async ms => { lines.waits.push(ms); clock += ms; },
    out: text => lines.out.push(text), err: text => lines.err.push(text),
    ask: async () => { throw new Error('sem prompt'); }, capture: () => { throw new Error('sem capture'); },
    vault: memoryVault(), ...overrides };
  return { ctx, lines, advance: ms => { clock += ms; } };
}

export async function tempDir(prefix = 'qg-test-') { return mkdtemp(join(tmpdir(), prefix)); }
export const removeDir = path => rm(path, { recursive: true, force: true });
