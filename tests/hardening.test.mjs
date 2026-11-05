// Endurecimento pós-revisão: cofre, helper do Claude, diagnóstico, limites de entrada e sinais.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { writeFile, readFile, readdir, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, memoryVault, CATALOG, KEY, tempDir, removeDir } from './helpers.mjs';
import { main } from '../quebragalho.mjs';
import { createVault, CLAUDE_SERVICE } from '../lib/vault.mjs';
import { helperCommand } from '../lib/claude-setup.mjs';
import { isValidKey, readJsonBounded, printable } from '../lib/util.mjs';
import { networkCode, gatewayFetch } from '../lib/gateway.mjs';
import { requestDeviceCode } from '../lib/device.mjs';
import { loginCommand } from '../lib/login.mjs';
import { warnLowBalance } from '../lib/launch.mjs';

const POSIX = { skip: process.platform === 'win32' && 'PATH e permissões POSIX' };
const ACCOUNT = `claude-${'c'.repeat(64)}`;

test('chaves: só ASCII visível, até 512 caracteres', () => {
  assert.ok(isValidKey('a'.repeat(512)) && !isValidKey('a'.repeat(513)));
  for (const bad of ['', 'é', 'a b', 'a\tb', 'a\u0000b', 'a\u007fb', 'chave\n', 12, null]) assert.equal(isValidKey(bad), false, JSON.stringify(bad));
  fc.assert(fc.property(fc.stringMatching(/^[\x21-\x7e]{1,40}$/), key => isValidKey(key)), { numRuns: 200 });
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.constantFrom(' ', '\n', '\t', '\u0000', 'é'), (text, bad) => !isValidKey(text + bad)), { numRuns: 200 });
});

test('texto do servidor no terminal: sem controle nem escape, com limite', () => {
  assert.equal(printable('ok\u001b]0;título\u0007 fim\u009b\r\n'), 'ok]0;título fim');
  assert.equal(printable('a'.repeat(500)).length, 300);
  assert.equal(printable('abcdef', 3), 'abc');
  fc.assert(fc.property(fc.string({ maxLength: 60 }), text => !/[\x00-\x1f\x7f-\x9f]/.test(printable(text))), { numRuns: 300 });
});

test('corpo JSON limitado: grande, inválido ou vazio viram undefined', async () => {
  assert.deepEqual(await readJsonBounded(new Response('{"a":1}')), { a: 1 });
  assert.equal(await readJsonBounded(new Response('x'.repeat(100)), 50), undefined);
  assert.equal(await readJsonBounded(new Response('não é json')), undefined);
  assert.equal(await readJsonBounded(new Response('')), undefined);
  assert.equal(await readJsonBounded(new Response('{"a":"123456"}'), 13), undefined);
  assert.deepEqual(await readJsonBounded(new Response('{"a":"1234"}'), 12), { a: '1234' });
});

test('erro de rede mostra só o código técnico, nunca a mensagem', async () => {
  assert.equal(networkCode(Object.assign(new TypeError(`falha ${KEY}`), { cause: { code: 'ENOTFOUND' } })), ' (ENOTFOUND)');
  assert.equal(networkCode(new DOMException('x', 'TimeoutError')), ' (TimeoutError)');
  assert.equal(networkCode(new TypeError('x')), ' (TypeError)');
  assert.equal(networkCode({ code: 'com espaço e https://x' }), '');
  assert.equal(networkCode(null), '');
  const { ctx } = makeCtx({ fetch: async () => { throw Object.assign(new TypeError(`https://api.quebragalho.dev ${KEY}`), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(gatewayFetch(ctx, 'https://api.quebragalho.dev', KEY, '/v1/models'), error => error.message.includes('(ECONNRESET)') && !error.message.includes(KEY) && !error.message.includes('https'));
});

test('login: intervalo do servidor é limitado a 60 s e o texto do servidor é limpo', async () => {
  const code = { device_code: 'd', user_code: 'ABCD\u001b[2J-1234', verification_uri: 'https://app.quebragalho.dev/\u001b]0;x\u0007connect', interval: 3600, expires_in: 600 };
  const { ctx, lines } = makeCtx({ fetch: async url => (new URL(url).pathname.endsWith('/code') ? json(code) : json({ error: 'access_denied' }, { status: 400 })) });
  assert.equal((await requestDeviceCode(ctx, 'https://app.quebragalho.dev/api/cli/v1')).intervalMs, 60000);
  await assert.rejects(loginCommand(ctx, ['--sem-navegador']), /negado/);
  const text = lines.out.join('\n');
  assert.ok(text.includes('ABCD[2J-1234') && !text.includes('\u001b'), 'sem caractere de escape no terminal');
});

test('login com servidor local: loopback só é aberto quando o login também é local', async () => {
  const code = { device_code: 'd', user_code: 'U-1', verification_uri: 'http://localhost:3000/connect', verification_uri_complete: 'http://localhost:3000/connect?c=U-1', interval: 1, expires_in: 600 };
  const answers = [json({ access_token: KEY }), json(CATALOG)];
  const fetch = async url => (new URL(url).pathname.endsWith('/code') ? json(code) : answers.shift());
  const { ctx, lines } = makeCtx({ fetch, isTTY: true, env: { PATH: '', QUEBRAGALHO_BASE_URL: 'http://localhost:9999', QUEBRAGALHO_AUTH_URL: 'http://localhost:3000/api' } });
  await loginCommand(ctx, []);
  assert.match(lines.out.join('\n'), /Login concluído/);
});

test('Given libsecret que falhou antes Then o arquivo (mais novo) vence e o libsecret velho é limpo', POSIX, async () => {
  const dir = await tempDir('qg-vault2-');
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'secret-tool'), '#!/bin/sh\n', { mode: 0o755 });
    const items = new Map([['service/dev.quebragalho.cli/account/default', 'chave-velha']]);
    const calls = [];
    const ctx = { env: { XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: join(dir, 'bin') }, platform: 'linux', homedir: () => dir,
      exec: (file, args, options = {}) => {
        calls.push(args[0]);
        const attrs = args.slice(args.indexOf('service')).join('/');
        if (args[0] === 'store') throw new Error('keyring bloqueado');
        if (args[0] === 'lookup') { if (!items.has(attrs)) throw new Error('nf'); return items.get(attrs); }
        if (args[0] === 'clear') { items.delete(attrs); return ''; }
        throw new Error(args[0]);
      } };
    const vault = createVault(ctx);
    assert.equal((await vault.set('dev.quebragalho.cli', 'default', KEY)).kind, 'file');
    assert.ok(calls.includes('clear'), 'tenta limpar a entrada velha do libsecret');
    assert.equal(await vault.get('dev.quebragalho.cli', 'default'), KEY);
    items.set('service/dev.quebragalho.cli/account/default', 'chave-velha');
    assert.equal(await vault.get('dev.quebragalho.cli', 'default'), KEY, 'mesmo com a velha ainda no chaveiro');
  } finally { await removeDir(dir); }
});

test('Given arquivo do cofre ilegível Then é erro explícito, não "sem chave"; ausente é undefined', POSIX, async () => {
  const dir = await tempDir('qg-vault3-');
  try {
    const ctx = { env: { XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '', QUEBRAGALHO_VAULT: 'file' }, platform: 'linux', homedir: () => dir, exec: () => { throw new Error('sem exec'); } };
    const vault = createVault(ctx);
    assert.equal(await vault.get('dev.quebragalho.cli', 'default'), undefined);
    await vault.set('dev.quebragalho.cli', 'default', KEY);
    const directory = join(dir, 'xdg', 'quebragalho', 'vault');
    const [file] = await readdir(directory);
    await chmod(join(directory, file), 0o000);
    if (process.getuid?.() !== 0) await assert.rejects(vault.get('dev.quebragalho.cli', 'default'), /ler a chave guardada em arquivo/);
    await chmod(join(directory, file), 0o600);
    await chmod(directory, 0o755);
    await vault.set('dev.quebragalho.cli', 'default', `${KEY}2`);
    assert.equal(await vault.get('dev.quebragalho.cli', 'default'), `${KEY}2`);
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), [], 'sem temporário do cofre');
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(directory)).mode & 0o777, 0o700, 'diretório existente volta a 0700');
  } finally { await removeDir(dir); }
});

test('helper do Claude: launcher precisa ser absoluto; QUEBRAGALHO_VAULT=file vai no comando', () => {
  const unix = (launcher, extra = {}) => helperCommand({ env: { QUEBRAGALHO_LAUNCHER: launcher, ...extra }, platform: 'linux' }, 'claude-x', '/app/q.mjs');
  assert.equal(unix('/usr/bin/q'), "'/usr/bin/q' __key claude-x");
  assert.equal(unix('relativo/q'), "node '/app/q.mjs' __key claude-x");
  assert.equal(unix('q'), "node '/app/q.mjs' __key claude-x");
  assert.equal(unix('/usr/bin/q\n; rm -rf ~'), "node '/app/q.mjs' __key claude-x");
  assert.equal(unix('/usr/bin/q', { QUEBRAGALHO_VAULT: 'file' }), "'/usr/bin/q' __key claude-x file");
  assert.equal(unix('/usr/bin/q', { QUEBRAGALHO_VAULT: 'outro' }), "'/usr/bin/q' __key claude-x");
  assert.equal(helperCommand({ env: { QUEBRAGALHO_LAUNCHER: 'C:\\q\\q.cmd' }, platform: 'win32' }, 'claude-x', 'x'), '"C:\\q\\q.cmd" __key claude-x');
  assert.equal(helperCommand({ env: { QUEBRAGALHO_LAUNCHER: 'relativo\\q.cmd' }, platform: 'win32' }, 'claude-x', 'C:\\a\\q.mjs'), 'node "C:\\a\\q.mjs" __key claude-x');
});

async function setupFixture(platform, env = {}, vault = memoryVault('keychain')) {
  const dir = await tempDir('qg-hard-');
  const server = router({ 'GET /v1/models': json(CATALOG) });
  const built = makeCtx({ fetch: server.fetch, platform, homedir: () => join(dir, 'home'), capture: () => '2.1.286', vault,
    env: { XDG_CONFIG_HOME: join(dir, 'xdg'), APPDATA: join(dir, 'ap'), PATH: '', QUEBRAGALHO_API_KEY: KEY, QUEBRAGALHO_LAUNCHER: '/bin/q', ...env } });
  return { dir, ...built };
}

test('Given macOS com QUEBRAGALHO_VAULT=file Then o helper usa o launcher (o Chaves não tem a chave)', async () => {
  const f = await setupFixture('darwin', { QUEBRAGALHO_VAULT: 'file' }, memoryVault('file'));
  try {
    await main(['setup', 'claude'], f.ctx);
    const settings = JSON.parse(await readFile(join(f.dir, 'xdg', 'quebragalho', 'claude', 'settings.json'), 'utf8'));
    assert.match(settings.apiKeyHelper, /^'\/bin\/q' __key claude-[0-9a-f]{64} file$/);
  } finally { await removeDir(f.dir); }
});

test('Given __key com o argumento file Then lê do arquivo mesmo sem QUEBRAGALHO_VAULT no ambiente', POSIX, async () => {
  const dir = await tempDir('qg-key-');
  const original = process.stdout.write;
  const written = [];
  try {
    const base = { env: { XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' }, platform: 'darwin', homedir: () => dir, exec: () => { throw new Error('o Chaves não deve ser consultado'); }, out() {}, err() {} };
    const forced = createVault({ ...base, env: { ...base.env, QUEBRAGALHO_VAULT: 'file' } });
    await forced.set(CLAUDE_SERVICE, ACCOUNT, KEY);
    const ctx = { ...base, vault: createVault(base) };
    process.stdout.write = chunk => { written.push(String(chunk)); return true; };
    await main(['__key', ACCOUNT, 'file'], ctx);
    process.stdout.write = original;
    assert.deepEqual(written, [`${KEY}\n`]);
    await assert.rejects(main(['__key', ACCOUNT, 'outro'], ctx), /interno/);
    await assert.rejects(main(['__key'], ctx), /interno/);
  } finally { process.stdout.write = original; await removeDir(dir); }
});

test('Given falha ao gravar o settings.json Then a entrada nova do cofre não fica órfã; a antiga fica', async () => {
  const f = await setupFixture('linux');
  try {
    const profile = join(f.dir, 'xdg', 'quebragalho', 'claude');
    await mkdir(profile, { recursive: true });
    await mkdir(join(profile, 'settings.json'));
    await assert.rejects(main(['setup', 'claude'], f.ctx));
    assert.equal(f.ctx.vault.items.size, 0, 'nada órfão');
    const keep = await setupFixture('linux');
    try {
      await mkdir(join(keep.dir, 'xdg', 'quebragalho', 'claude', 'settings.json'), { recursive: true });
      await main(['setup', 'claude'], keep.ctx).catch(() => {});
      assert.equal(keep.ctx.vault.items.size, 0);
    } finally { await removeDir(keep.dir); }
  } finally { await removeDir(f.dir); }
});

test('Given entrada pré-existente no cofre Then falha ao gravar settings não a apaga', async () => {
  const f = await setupFixture('linux');
  try {
    await main(['setup', 'claude'], f.ctx);
    const [entry] = [...f.ctx.vault.items.keys()];
    const settings = join(f.dir, 'xdg', 'quebragalho', 'claude', 'settings.json');
    const before = await readFile(settings, 'utf8');
    await writeFile(settings, '[]');
    await assert.rejects(main(['setup', 'claude'], f.ctx), /objeto JSON válido/);
    assert.ok(f.ctx.vault.items.has(entry));
    assert.notEqual(before, '[]');
  } finally { await removeDir(f.dir); }
});

const probes = overrides => ({ 'GET /v1/models': json({}, { status: 401 }), 'GET /v1/key': json({ name: 'k', key_prefix: 'p' }), 'GET /v1/balance': json({ available: '5' }),
  'POST /v1/messages': json({}, { status: 400 }), 'POST /v1/chat/completions': json({}, { status: 400 }), 'POST /v1/responses': json({}, { status: 400 }), ...overrides });

test('doctor: 5xx e 429 não provam compatibilidade; 401, 405 e 400 provam a rota; 404 não', async () => {
  for (const [status, expected] of [[502, null], [500, null], [429, null], [401, true], [403, true], [405, true], [400, true], [404, false], [499, true]]) {
    const { ctx, lines } = makeCtx({ fetch: router(probes({ 'POST /v1/responses': json({}, { status }) })).fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' } });
    await main(['doctor', '--json'], ctx);
    assert.equal(JSON.parse(lines.out[0]).harnesses.find(row => row.name === 'codex').available, expected, String(status));
  }
});

test('doctor: configuração inválida vira item de falha com relatório completo e exit 1', async () => {
  for (const env of [{ QUEBRAGALHO_BASE_URL: 'http://example.com' }, { QUEBRAGALHO_API_KEY: 'com espaço' }]) {
    const { ctx, lines } = makeCtx({ env: { PATH: '', ...env } });
    process.exitCode = 0;
    await main(['doctor', '--json'], ctx);
    const report = JSON.parse(lines.out[0]);
    assert.equal(report.ok, false);
    assert.equal(process.exitCode, 1);
    assert.equal(report.checks.find(check => check.id === 'configuração').status, 'fail');
    assert.ok(report.checks.some(check => check.id === 'node') && report.harnesses.length === 5);
  }
  const unexpected = makeCtx({ env: { PATH: '' }, vault: { kind: 'x', label: 'x', get: async () => { throw new TypeError('quebrou'); } } });
  process.exitCode = 0;
  await main(['doctor', '--json'], unexpected.ctx);
  assert.match(JSON.parse(unexpected.lines.out[0]).checks.find(check => check.id === 'configuração').detail, /ler a chave do cofre/);
  process.exitCode = 0;
});

test('doctor: respostas estranhas do gateway não derrubam o comando', async () => {
  const { ctx, lines } = makeCtx({ fetch: router(probes({ 'GET /v1/key': json(null), 'GET /v1/balance': json(null) })).fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' } });
  await main(['doctor', '--json'], ctx);
  const report = JSON.parse(lines.out[0]);
  assert.match(report.checks.find(check => check.id === 'chave-valida').detail, /chave \(\?\.\.\.\)/);
  assert.equal(report.checks.find(check => check.id === 'saldo').detail, 'indisponível');
  const errors = makeCtx({ fetch: router(probes({ 'GET /v1/key': () => { throw new RangeError('x'); } })).fetch, env: { QUEBRAGALHO_API_KEY: KEY, PATH: '' } });
  process.exitCode = 0;
  await main(['doctor', '--json'], errors.ctx);
  const failed = JSON.parse(errors.lines.out[0]).checks.find(check => check.id === 'chave-valida');
  assert.equal(failed.status, 'fail');
  assert.match(failed.detail, /Não foi possível conectar/);
  process.exitCode = 0;
});

test('saldo nulo ou ausente não vira aviso de saldo zerado no launch', async () => {
  for (const available of [null, undefined, '', [], {}]) {
    const { ctx, lines } = makeCtx({ fetch: router({ 'GET /v1/balance': json({ available }) }).fetch });
    await warnLowBalance(ctx, 'https://api.quebragalho.dev', KEY);
    assert.deepEqual(lines.err, [], JSON.stringify(available));
  }
  const { ctx, lines } = makeCtx({ fetch: router({ 'GET /v1/balance': json({ available: '0' }) }).fetch });
  await warnLowBalance(ctx, 'https://api.quebragalho.dev', KEY);
  assert.equal(lines.err.length, 1);
});
