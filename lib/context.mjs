// Dependências do mundo externo reunidas num objeto, para os testes trocarem por simuladas.
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createVault, loginAccount, LOGIN_SERVICE } from './vault.mjs';
import { DEFAULT_BASE, normalizeBase } from './gateway.mjs';
import { resolveCommand, spawnPlan, missingHarnessError } from './proc.mjs';
import { QgError, isValidKey } from './util.mjs';

const execFile = (file, args, { input, timeout } = {}) => execFileSync(file, args,
  { encoding: 'utf8', input, timeout, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });

async function ask(ctx, question, secret = false) {
  if (!ctx.isTTY) throw new QgError('Execute em um terminal interativo ou defina QUEBRAGALHO_API_KEY no ambiente.');
  const input = ctx.input ?? process.stdin;
  const shown = ctx.output ?? process.stdout;
  const output = secret ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : shown;
  const prompt = createInterface({ input, output, terminal: true });
  try {
    if (secret) shown.write(question);
    return (await prompt.question(secret ? '' : question)).trim();
  } finally { prompt.close(); if (secret) shown.write('\n'); }
}

// Roda um comando do PATH sem shell e devolve a saída; falha com mensagem clara se faltar ou não responder.
function capture(ctx, name, args) {
  const file = resolveCommand(name, { env: ctx.env, platform: ctx.platform });
  if (!file) throw missingHarnessError(name);
  const plan = spawnPlan(file, args, { env: ctx.env, platform: ctx.platform });
  const result = spawnSync(plan.command, plan.args, { ...plan.options, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new QgError(`${name} não respondeu.`);
  return result.stdout;
}

export function createContext(overrides = {}) {
  const ctx = {
    env: process.env, platform: process.platform, homedir, isTTY: Boolean(process.stdin.isTTY),
    fetch: (...args) => globalThis.fetch(...args), exec: execFile, now: () => Date.now(),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    out: text => console.log(text), err: text => console.error(text),
    ask: (question, secret) => ask(ctx, question, secret), capture: (name, args) => capture(ctx, name, args),
    ...overrides,
  };
  ctx.vault ??= createVault(ctx);
  return ctx;
}

// Gateway e chave: a variável de ambiente vence; sem ela, a chave do cofre (só para a mesma URL base).
export async function resolveAuth(ctx, { required = true } = {}) {
  const base = normalizeBase(ctx.env.QUEBRAGALHO_BASE_URL || DEFAULT_BASE);
  let key = ctx.env.QUEBRAGALHO_API_KEY;
  let source = 'env';
  if (!key) {
    try { key = await ctx.vault.get(LOGIN_SERVICE, loginAccount(base)); }
    catch (error) { throw error instanceof QgError ? error : new QgError('Não foi possível ler a chave do cofre.'); }
    source = 'cofre';
  }
  if (!key) {
    if (required) throw new QgError('Sem chave. Rode quebragalho login ou defina QUEBRAGALHO_API_KEY.');
    return { base, key: undefined, source: 'nenhuma' };
  }
  if (!isValidKey(key)) throw new QgError('Chave com caracteres inválidos.');
  return { base, key, source };
}
