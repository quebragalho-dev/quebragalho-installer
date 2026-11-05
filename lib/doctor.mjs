// quebragalho doctor: diagnóstico local e do gateway. Falha de rede nunca derruba o comando;
// só um item "falha" (ex.: chave recusada) dá código de saída 1. Nunca imprime a chave.
import { win32, posix } from 'node:path';
import { QgError, parseOptions, asJson } from './util.mjs';
import { resolveAuth } from './context.mjs';
import { fetchBalance, fetchKeyInfo, gatewayFetch, probeEndpoint } from './gateway.mjs';
import { harnesses } from './harness.mjs';
import { resolveCommand, envValue } from './proc.mjs';
import { formatBRL } from './format.mjs';

// API que cada harness exige. Codex depende de /v1/responses.
export const HARNESS_ENDPOINTS = { claude: '/v1/messages', codex: '/v1/responses', opencode: '/v1/chat/completions', aider: '/v1/chat/completions', pi: '/v1/chat/completions' };
const MARKS = { ok: '[ok]', warn: '[aviso]', fail: '[falha]' };
const check = (id, status, detail) => ({ id, status, detail });

function localChecks(ctx) {
  const major = Number(process.versions.node.split('.')[0]);
  const wsl = ctx.env.WSL_DISTRO_NAME ? ' (WSL)' : '';
  const launcher = ctx.env.QUEBRAGALHO_LAUNCHER;
  const pathDirs = (envValue(ctx.env, 'PATH', ctx.platform) ?? '').split(ctx.platform === 'win32' ? ';' : ':');
  const normalize = dir => (ctx.platform === 'win32' ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '');
  const onPath = launcher ? pathDirs.map(normalize).includes(normalize((ctx.platform === 'win32' ? win32 : posix).dirname(launcher))) : null;
  return [
    check('node', major >= 22 ? 'ok' : 'fail', `Node ${process.versions.node}${major >= 22 ? '' : ' (requer 22+)'}`),
    check('sistema', 'ok', `${ctx.platform}${wsl} ${process.arch}`),
    check('path', onPath === false ? 'warn' : 'ok', onPath === null ? 'executado sem o launcher instalado' : onPath ? 'diretório do launcher no PATH' : 'diretório do launcher fora do PATH'),
    check('cofre', ctx.vault.kind === 'file' ? 'warn' : 'ok', ctx.vault.label),
  ];
}

async function gatewayChecks(ctx, auth) {
  const { base, key, source } = auth;
  const reach = await gatewayFetch(ctx, base, undefined, '/v1/models', { timeoutMs: 8000 }).then(() => true, () => false);
  const items = [check('gateway', reach ? 'ok' : 'warn', reach ? 'alcançável' : 'sem resposta (rede ou URL)'), check('chave', key ? 'ok' : 'warn', key ? `presente (${source})` : 'ausente: rode quebragalho login')];
  if (!key || !reach) return { items, working: {} };
  const [info, balance, probes] = await Promise.all([
    fetchKeyInfo(ctx, base, key).then(value => value, error => error),
    fetchBalance(ctx, base, key).then(value => value, error => error),
    Promise.all([...new Set(Object.values(HARNESS_ENDPOINTS))].map(async path => [path, await probeEndpoint(ctx, base, key, path)])),
  ]);
  items.push(info instanceof Error ? check('chave-valida', 'fail', info instanceof QgError ? info.message : 'consulta falhou') : check('chave-valida', 'ok', `${info?.name ?? 'chave'} (${info?.key_prefix ?? '?'}...)`));
  items.push(balance instanceof Error ? check('saldo', 'warn', balance instanceof QgError ? balance.message : 'consulta falhou') : check('saldo', 'ok', formatBRL(balance?.available) ?? 'indisponível'));
  return { items, working: Object.fromEntries(probes) };
}

function harnessRows(ctx, probes) {
  return harnesses.map(name => {
    const installed = Boolean(resolveCommand(name, { env: ctx.env, platform: ctx.platform }));
    const endpoint = HARNESS_ENDPOINTS[name];
    const status = probes[endpoint];
    // 404 = rota inexistente. Sem resposta, 5xx e 429 não provam nada; o resto (400, 401, 405...) prova que a rota existe.
    const available = status === undefined || status === null || status >= 500 || status === 429 ? null : status !== 404;
    return { name, installed, endpoint, available, reason: available === false ? `o gateway não oferece ${endpoint} (HTTP 404)` : undefined };
  });
}

export function renderDoctor(report) {
  const lines = report.checks.map(item => `${MARKS[item.status]} ${item.id}: ${item.detail}`);
  lines.push('Harnesses:');
  for (const row of report.harnesses) {
    const state = row.available === false ? `indisponível (${row.reason})${row.installed ? '' : '; não instalado'}`
      : !row.installed ? 'não instalado' : row.available === null ? 'instalado (compatibilidade não verificada)' : 'instalado e compatível';
    lines.push(`  ${row.name}: ${state}`);
  }
  return lines.join('\n');
}

export async function doctorCommand(ctx, args) {
  const { flags } = parseOptions(args, { flags: ['json'] });
  let items;
  let working = {};
  try { ({ items, working } = await gatewayChecks(ctx, await resolveAuth(ctx, { required: false }))); }
  catch (error) { items = [check('configuração', 'fail', error instanceof QgError ? error.message : 'não foi possível ler a configuração')]; }
  const checks = [...localChecks(ctx), ...items];
  const report = { ok: !checks.some(item => item.status === 'fail'), checks, harnesses: harnessRows(ctx, working) };
  ctx.out(flags.json ? asJson(report) : renderDoctor(report));
  if (!report.ok) process.exitCode = 1;
}
