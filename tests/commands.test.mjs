// saldo, uso, conta, status, modelos, doctor, list e resolução de chave (env > cofre).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, CATALOG, KEY, tempDir, removeDir } from './helpers.mjs';
import { main, HELP } from '../quebragalho.mjs';
import { LOGIN_SERVICE, loginAccount } from '../lib/vault.mjs';
import { resolveAuth } from '../lib/context.mjs';
import { QgError } from '../lib/util.mjs';
import { renderDoctor } from '../lib/doctor.mjs';

const BASE = 'https://api.quebragalho.dev';
const STATUS = { object: 'status', generated_at: 'x', stale: false, overall: { status: 'degraded', counts: { operational: 16, degraded: 1, outage: 0, no_data: 1, maintenance: 0 } },
  platform_notice: 'Janela de manutenção às 3h', notices: [{ message: 'Latência alta no luna' }],
  data: [{ id: 'gpt-6-luna', display_name: 'GPT-6 Luna', status: 'degraded', windows: { '30m': { success_rate: 0.97 } } }, { id: 'model-a', display_name: null, status: 'operational', windows: {} }] };
const routes = () => ({
  'GET /v1/balance': json({ currency: 'BRL', available: '145.05489680807', default: '100.5', bonus: '44.55489680807' }),
  'GET /v1/key': json({ id: 'key_secret_id', name: 'meu notebook', key_prefix: 'qg-sk-ab12', created_at: '2026-10-01T10:00:00Z', allowed_models: null, plan: { code: 'pro', type: 'prepaid' } }),
  'GET /v1/usage': json({ from: 'a', to: 'b', scope: 'key', requests: 1234, input_tokens: 5000000, output_tokens: 250000, cached_input_tokens: 1000 }),
  'GET /v1/status': json(STATUS), 'GET /v1/models': json(CATALOG),
});
const setup = (extra = {}) => {
  const server = router(routes());
  const built = makeCtx({ fetch: server.fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' }, ...extra });
  return { ...built, server };
};
const text = lines => lines.out.join('\n');

test('Given chave When saldo Then mostra disponível, recarregado e bônus em reais, e --json traz os valores crus', async () => {
  const { ctx, lines, server } = setup();
  await main(['saldo'], ctx);
  assert.equal(text(lines), 'Disponível: R$ 145,05\nRecarregado: R$ 100,50\nBônus: R$ 44,55');
  assert.equal(server.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(server.calls[0].options.redirect, 'error');
  await main(['saldo', '--json'], ctx);
  assert.deepEqual(JSON.parse(lines.out.at(-1)), { currency: 'BRL', available: '145.05489680807', recharged: '100.5', bonus: '44.55489680807' });
});

test('Given período When uso Then consulta a chave atual na janela pedida (≤ 31 dias)', async () => {
  const { ctx, lines, server } = setup();
  await main(['uso', '--periodo', '7d'], ctx);
  const query = new URL(server.calls[0].url).searchParams;
  assert.equal(query.get('scope'), 'key');
  assert.equal(Date.parse(query.get('to')) - Date.parse(query.get('from')), 7 * 24 * 3600 * 1000);
  assert.match(query.get('from'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(text(lines), /Requisições: 1\.234/);
  assert.match(text(lines), /Entrada: 5\.000\.000 tokens \(cache: 1\.000\)/);
  assert.match(text(lines), /Total: 5\.250\.000 tokens/);
  await main(['uso', '--json'], ctx);
  assert.equal(JSON.parse(lines.out.at(-1)).period, '24h');
  await main(['uso', '--periodo', '30d'], ctx);
  await assert.rejects(main(['uso', '--periodo', '90d'], ctx), /Período inválido/);
});

test('Given chave When conta Then só nome, prefixo, plano e modelos: nunca o id nem dado pessoal', async () => {
  const { ctx, lines } = setup();
  await main(['conta'], ctx);
  assert.equal(text(lines), 'Chave: meu notebook (qg-sk-ab12...)\nPlano: pro (prepaid)\nCriada em: 2026-10-01T10:00:00Z\nModelos permitidos: todos');
  await main(['conta', '--json'], ctx);
  const view = JSON.parse(lines.out.at(-1));
  assert.deepEqual(Object.keys(view).sort(), ['allowedModels', 'createdAt', 'keyPrefix', 'name', 'plan']);
  assert.ok(!lines.out.join('').includes('key_secret_id'));
  const restricted = setup();
  restricted.server = router({ ...routes(), 'GET /v1/key': json({ name: 'k', key_prefix: 'p', created_at: 'c', allowed_models: ['a', 'b'], plan: { code: 'x', type: 'y' } }) });
  restricted.ctx.fetch = restricted.server.fetch;
  await main(['conta'], restricted.ctx);
  assert.match(text(restricted.lines), /Modelos permitidos: a, b/);
  const empty = setup();
  empty.ctx.fetch = router({ ...routes(), 'GET /v1/key': json({ allowed_models: [] }) }).fetch;
  await main(['conta'], empty.ctx);
  assert.match(text(empty.lines), /Chave: - \(-\.\.\.\)\nPlano: - \(-\)\nCriada em: -\nModelos permitidos: nenhum/);
});

test('Given status When geral e por modelo Then mostra estado, avisos e filtra por id ou nome', async () => {
  const { ctx, lines } = setup();
  await main(['status'], ctx);
  assert.match(text(lines), /Geral: degradado \(16 operacional, 1 degradado, 0 fora do ar, 1 sem dados, 0 em manutenção\)/);
  assert.match(text(lines), /Aviso: Janela de manutenção/);
  assert.match(text(lines), /Aviso: Latência alta/);
  assert.match(text(lines), /GPT-6 Luna\s+degradado\s+0\.97/);
  assert.match(text(lines), /model-a\s+operacional\s+-/);
  await main(['status', 'luna', '--json'], ctx);
  const filtered = JSON.parse(lines.out.at(-1));
  assert.deepEqual(filtered.data.map(row => row.id), ['gpt-6-luna']);
  assert.equal(filtered.overall.status, 'degraded');
  await assert.rejects(main(['status', 'inexistente'], ctx), /não encontrado no status/);
  const bare = setup();
  bare.ctx.fetch = router({ ...routes(), 'GET /v1/status': json({ overall: { status: 'weird' }, data: [] }) }).fetch;
  await main(['status'], bare.ctx);
  assert.match(text(bare.lines), /Geral: weird \(\)/);
});

test('Given catálogo When modelos Then preços por 1M em USD e BRL, contexto, saída, capacidades e oferta', async () => {
  const { ctx, lines } = setup();
  await main(['modelos'], ctx);
  const output = text(lines);
  assert.match(output, /gpt-6-luna\s+200K\s+32K\s+FVR\s+US\$ 1,25 \/ US\$ 10,00\s+R\$ 6,875 \/ R\$ 55,00\s+relampago -20%/);
  assert.match(output, /model-a\s+-\s+-\s+---/);
  assert.ok(!output.includes('systemone'));
  assert.match(output, /Preços por 1M de tokens/);
  await main(['modelos', '--decisao'], ctx);
  assert.ok(lines.out.at(-1).includes('systemone') && lines.out.at(-1).includes('decisor-2') && !lines.out.at(-1).includes('gpt-6-luna'));
  await main(['modelos', '--visao', '--json'], ctx);
  assert.deepEqual(JSON.parse(lines.out.at(-1)).map(m => m.id), ['gpt-6-luna']);
  await main(['modelos', '--busca', 'nada'], ctx);
  assert.equal(lines.out.at(-1), 'Nenhum modelo encontrado.');
  await main(['modelos', '--ferramentas', '--busca', 'luna'], ctx);
  assert.match(lines.out.at(-1), /gpt-6-luna/);
});

test('Given erros do gateway When consulta Then mensagens claras, sem chave nem corpo', async () => {
  for (const [status, headers, pattern] of [[401, {}, /Chave recusada.*quebragalho login/], [429, { 'Retry-After': '12' }, /429.*12 s/], [429, {}, /429/], [500, {}, /HTTP 500/]]) {
    const { ctx } = setup({ fetch: async () => json({ error: `corpo-${KEY}` }, { status, headers }) });
    await assert.rejects(main(['saldo'], ctx), error => pattern.test(error.message) && !error.message.includes(KEY) && !error.message.includes('corpo'));
  }
  const offline = setup({ fetch: async () => { throw new TypeError(`falha ${KEY} https://api.quebragalho.dev`); } });
  await assert.rejects(main(['saldo'], offline.ctx), error => /conectar/.test(error.message) && !error.message.includes(KEY) && !error.message.includes('https'));
  const invalid = setup({ fetch: async () => new Response('não é json', { status: 200 }) });
  await assert.rejects(main(['saldo'], invalid.ctx), /Resposta inválida/);
});

test('Given cofre com login e sem variável Then usa a chave do cofre; a variável tem prioridade', async () => {
  const server = router(routes());
  const stored = makeCtx({ fetch: server.fetch, env: { PATH: '' } });
  await stored.ctx.vault.set(LOGIN_SERVICE, loginAccount(BASE), 'chave-do-cofre');
  await main(['saldo'], stored.ctx);
  assert.equal(server.calls[0].options.headers.Authorization, 'Bearer chave-do-cofre');
  const both = makeCtx({ fetch: server.fetch, env: { PATH: '', QUEBRAGALHO_API_KEY: KEY }, vault: stored.ctx.vault });
  await main(['saldo'], both.ctx);
  assert.equal(server.calls.at(-1).options.headers.Authorization, `Bearer ${KEY}`);
  const none = makeCtx({ fetch: server.fetch, env: { PATH: '' } });
  await assert.rejects(main(['saldo'], none.ctx), /quebragalho login/);
  assert.deepEqual(await resolveAuth(none.ctx, { required: false }), { base: BASE, key: undefined, source: 'nenhuma' });
});

test('Given URL base própria Then a chave do login oficial nunca é enviada a ela', async () => {
  const server = router(routes());
  const { ctx } = makeCtx({ fetch: server.fetch, env: { PATH: '', QUEBRAGALHO_BASE_URL: 'https://gateway.example/v1' } });
  await ctx.vault.set(LOGIN_SERVICE, loginAccount(BASE), 'chave-oficial');
  await assert.rejects(main(['saldo'], ctx), /quebragalho login/);
  assert.equal(server.calls.length, 0);
  await assert.rejects(resolveAuth(makeCtx({ env: { QUEBRAGALHO_API_KEY: 'com espaço' } }).ctx), /inválidos/);
  await assert.rejects(resolveAuth(makeCtx({ env: { QUEBRAGALHO_BASE_URL: 'http://example.com', QUEBRAGALHO_API_KEY: 'k' } }).ctx), QgError);
  const failing = makeCtx({ vault: { get: async () => { throw new Error('cofre quebrado'); } }, env: {} });
  await assert.rejects(resolveAuth(failing.ctx, { required: false }), error => error instanceof QgError && /ler a chave do cofre/.test(error.message) && !error.message.includes('quebrado'));
  const locked = makeCtx({ vault: { get: async () => { throw new QgError('Chaves bloqueado'); } }, env: {} });
  await assert.rejects(resolveAuth(locked.ctx), /Chaves bloqueado/);
});

test('Given list, ajuda e comandos desconhecidos Then respostas previsíveis', async () => {
  const { ctx, lines } = setup();
  await main(['list'], ctx);
  assert.equal(text(lines), 'claude\ncodex\nopencode\naider\npi');
  await main(['list', '--json'], ctx);
  assert.deepEqual(JSON.parse(lines.out.at(-1)), ['claude', 'codex', 'opencode', 'aider', 'pi']);
  await main([], ctx);
  assert.equal(lines.out.at(-1), HELP);
  await main(['launch', 'claude', '--help'], ctx);
  assert.equal(lines.out.at(-1), HELP);
  await assert.rejects(main(['list', 'x'], ctx), /demais/);
  await assert.rejects(main(['naoexiste'], ctx), /desconhecido/);
  await assert.rejects(main(['constructor'], ctx), /desconhecido/);
  await assert.rejects(main(['setup'], ctx), /setup claude/);
  await assert.rejects(main(['setup', 'outro'], ctx), /setup claude/);
  await assert.rejects(main(['__key', 'abc'], ctx), /interno/);
  await assert.rejects(main(['__key', `claude-${'a'.repeat(64)}`], ctx), /não encontrada/);
});

const doctorRoutes = overrides => ({ ...routes(), 'POST /v1/messages': json({}, { status: 400 }), 'POST /v1/chat/completions': json({}, { status: 400 }),
  'POST /v1/responses': json({ error: 'not found' }, { status: 404 }), ...overrides });

test('Given tudo certo exceto /v1/responses When doctor Then Codex indisponível e exit 0, sem a chave na saída', async () => {
  const server = router(doctorRoutes({}));
  const { ctx, lines } = makeCtx({ fetch: server.fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' }, vault: Object.assign({ kind: 'keychain', label: 'cofre de teste' }, { get: async () => undefined }) });
  process.exitCode = 0;
  await main(['doctor', '--json'], ctx);
  const report = JSON.parse(lines.out[0]);
  assert.equal(report.ok, true);
  assert.equal(process.exitCode, 0);
  const byName = Object.fromEntries(report.harnesses.map(row => [row.name, row]));
  assert.equal(byName.codex.available, false);
  assert.match(byName.codex.reason, /\/v1\/responses.*404/);
  assert.equal(byName.claude.available, true);
  assert.equal(byName.pi.available, true);
  assert.ok(report.harnesses.every(row => row.installed === false));
  assert.deepEqual(report.checks.map(c => c.id), ['node', 'sistema', 'path', 'cofre', 'gateway', 'chave', 'chave-valida', 'saldo']);
  assert.ok(!lines.out.join('').includes(KEY));
  for (const call of server.calls.filter(c => c.route.startsWith('POST'))) assert.equal(call.options.body, undefined);
  await main(['doctor'], ctx);
  assert.match(lines.out.at(-1), /codex: indisponível \(o gateway não oferece \/v1\/responses \(HTTP 404\)\)/);
  assert.match(lines.out.at(-1), /\[ok\] saldo: R\$ 145,05/);
});

test('Given chave recusada When doctor Then falha e exit 1; sem chave e sem rede viram avisos', async () => {
  const rejected = makeCtx({ fetch: router(doctorRoutes({ 'GET /v1/key': json({}, { status: 401 }), 'GET /v1/balance': json({}, { status: 401 }) })).fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' } });
  process.exitCode = 0;
  await main(['doctor', '--json'], rejected.ctx);
  const report = JSON.parse(rejected.lines.out[0]);
  assert.equal(report.ok, false);
  assert.equal(process.exitCode, 1);
  assert.equal(report.checks.find(c => c.id === 'chave-valida').status, 'fail');
  assert.equal(report.checks.find(c => c.id === 'saldo').status, 'warn');
  process.exitCode = 0;
  const noKey = makeCtx({ fetch: router({ 'GET /v1/models': json({}, { status: 401 }) }).fetch, env: { PATH: '' } });
  await main(['doctor', '--json'], noKey.ctx);
  const withoutKey = JSON.parse(noKey.lines.out[0]);
  assert.equal(withoutKey.ok, true);
  assert.equal(withoutKey.checks.find(c => c.id === 'chave').status, 'warn');
  assert.ok(withoutKey.harnesses.every(row => row.available === null));
  const offline = makeCtx({ fetch: async () => { throw new TypeError('x'); }, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' } });
  await main(['doctor', '--json'], offline.ctx);
  const down = JSON.parse(offline.lines.out[0]);
  assert.equal(down.ok, true);
  assert.equal(down.checks.find(c => c.id === 'gateway').status, 'warn');
  assert.equal(process.exitCode, 0);
});

test('doctor: PATH do launcher, WSL, cofre em arquivo e harness instalado', { skip: process.platform === 'win32' && 'PATH POSIX' }, async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const launcher = join(dir, 'bin', 'quebragalho');
    const inPath = makeCtx({ fetch: async () => json({}, { status: 401 }), env: { PATH: `${join(dir, 'bin')}:/x`, QUEBRAGALHO_LAUNCHER: launcher, WSL_DISTRO_NAME: 'Ubuntu' }, vault: { kind: 'file', label: 'arquivo 0600', get: async () => undefined } });
    await main(['doctor', '--json'], inPath.ctx);
    const report = JSON.parse(inPath.lines.out[0]);
    assert.equal(report.checks.find(c => c.id === 'path').status, 'ok');
    assert.match(report.checks.find(c => c.id === 'sistema').detail, /\(WSL\)/);
    assert.equal(report.checks.find(c => c.id === 'cofre').status, 'warn');
    assert.equal(report.harnesses.find(row => row.name === 'claude').installed, true);
    const outside = makeCtx({ fetch: async () => json({}, { status: 401 }), env: { PATH: '/x', QUEBRAGALHO_LAUNCHER: launcher } });
    await main(['doctor', '--json'], outside.ctx);
    assert.equal(JSON.parse(outside.lines.out[0]).checks.find(c => c.id === 'path').status, 'warn');
    const windows = makeCtx({ platform: 'win32', fetch: async () => json({}, { status: 401 }), env: { Path: 'C:\\Bin\\;C:\\x', QUEBRAGALHO_LAUNCHER: 'c:\\bin\\quebragalho.cmd' } });
    await main(['doctor', '--json'], windows.ctx);
    assert.equal(JSON.parse(windows.lines.out[0]).checks.find(c => c.id === 'path').status, 'ok');
    assert.match(renderDoctor({ checks: [{ id: 'a', status: 'fail', detail: 'd' }], harnesses: [{ name: 'x', installed: true, available: null }, { name: 'y', installed: true, available: true }] }), /\[falha\] a: d[\s\S]*x: instalado \(compatibilidade não verificada\)[\s\S]*y: instalado e compatível/);
  } finally { await removeDir(dir); }
});
