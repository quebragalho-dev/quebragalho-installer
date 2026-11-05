// Aceitação do login por código: aprovado, negado, expirado, slow_down, 429, e o fluxo completo do comando.
import test from 'node:test';
import assert from 'node:assert/strict';
import { json, makeCtx, memoryVault, CATALOG, KEY } from './helpers.mjs';
import { requestDeviceCode, pollDeviceToken, pollOnce, isSafeToOpen, browserCommand, normalizeAuthBase } from '../lib/device.mjs';
import { loginCommand, logoutCommand, obtainKey } from '../lib/login.mjs';
import { LOGIN_SERVICE, loginAccount } from '../lib/vault.mjs';
import { QgError } from '../lib/util.mjs';

const AUTH = 'https://app.quebragalho.dev/api/cli/v1';
const CODE = { device_code: 'dev-code-secret', user_code: 'ABCD-1234', verification_uri: 'https://app.quebragalho.dev/connect/cli',
  verification_uri_complete: 'https://app.quebragalho.dev/connect/cli?code=ABCD-1234', expires_in: 600, interval: 5 };
const pending = () => json({ error: 'authorization_pending' }, { status: 400 });

// Sequência de respostas para /auth/device/token; guarda os corpos enviados.
function deviceServer(tokenReplies, codeReply = json(CODE)) {
  const bodies = [];
  let index = 0;
  const fetch = async (url, options) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/auth/device/code')) { bodies.push(['code', options.body]); return codeReply.clone(); }
    if (pathname.endsWith('/auth/device/token')) { bodies.push(['token', options.body]); return tokenReplies[Math.min(index++, tokenReplies.length - 1)].clone(); }
    if (pathname === '/v1/models') return json(CATALOG);
    return json({}, { status: 404 });
  };
  return { fetch, bodies };
}

test('Given o servidor de login When pede o código Then envia client_id em form urlencoded e guarda intervalo e expiração', async () => {
  const server = deviceServer([], json(CODE));
  const { ctx } = makeCtx({ fetch: server.fetch });
  const auth = await requestDeviceCode(ctx, AUTH);
  assert.equal(server.bodies[0][1], 'client_id=quebragalho-cli');
  assert.deepEqual([auth.deviceCode, auth.userCode, auth.intervalMs, auth.expiresAt - ctx.now()], ['dev-code-secret', 'ABCD-1234', 5000, 600000]);
});

test('Given resposta sem expires_in/interval ou exagerada Then usa 600 s, 5 s e limita a 1 h', async () => {
  const { ctx } = makeCtx({ fetch: deviceServer([], json({ device_code: 'd', user_code: 'u' })).fetch });
  const auth = await requestDeviceCode(ctx, AUTH);
  assert.deepEqual([auth.intervalMs, auth.expiresAt - ctx.now(), auth.verificationUri], [5000, 600000, '']);
  const { ctx: big } = makeCtx({ fetch: deviceServer([], json({ device_code: 'd', user_code: 'u', expires_in: 10 ** 9 })).fetch });
  assert.equal((await requestDeviceCode(big, AUTH)).expiresAt - big.now(), 3600000);
});

test('Given código inválido ou erro HTTP Then falha sem vazar corpo nem URL', async () => {
  for (const reply of [json({ nada: 1 }), json({ device_code: ' ', user_code: 'x' }), json({ device_code: 'a' }), new Response('<html>segredo-do-servidor</html>', { status: 200 }), json({ error: 'segredo-do-servidor' }, { status: 500 })]) {
    const { ctx } = makeCtx({ fetch: deviceServer([], reply).fetch });
    await assert.rejects(requestDeviceCode(ctx, AUTH), error => error instanceof QgError && !error.message.includes('segredo') && !error.message.includes('app.quebragalho'));
  }
  const { ctx } = makeCtx({ fetch: async () => { throw new TypeError('https://app.quebragalho.dev segredo'); } });
  await assert.rejects(requestDeviceCode(ctx, AUTH), error => !error.message.includes('segredo') && !error.message.includes('https'));
});

test('Given aprovação depois de pendências Then devolve a chave e respeita o intervalo', async () => {
  const server = deviceServer([pending(), pending(), json({ access_token: KEY })]);
  const { ctx, lines } = makeCtx({ fetch: server.fetch });
  const auth = await requestDeviceCode(ctx, AUTH);
  assert.equal(await pollDeviceToken(ctx, AUTH, auth), KEY);
  assert.deepEqual(lines.waits, [5000, 5000, 5000]);
  const token = new URLSearchParams(server.bodies.at(-1)[1]);
  assert.deepEqual([token.get('grant_type'), token.get('device_code'), token.get('client_id')], ['urn:ietf:params:oauth:grant-type:device_code', 'dev-code-secret', 'quebragalho-cli']);
});

test('Given os formatos de chave do servidor Then aceita access_token, key e api_key legado, e recusa o resto', async () => {
  for (const [body, expected] of [[{ access_token: ' k1 ' }, 'k1'], [{ key: 'k2' }, 'k2'], [{ api_key: 'k3' }, 'k3'], [{ api_key: { id: 'obj' }, access_token: 'k4' }, 'k4']]) {
    const { ctx } = makeCtx({ fetch: deviceServer([json(body)]).fetch });
    assert.deepEqual(await pollOnce(ctx, AUTH, { deviceCode: 'd' }), { state: 'ok', key: expected });
  }
  for (const body of [{}, { access_token: 'com espaço' }, { access_token: '' }, [1]]) {
    const { ctx } = makeCtx({ fetch: deviceServer([json(body)]).fetch });
    await assert.rejects(pollOnce(ctx, AUTH, { deviceCode: 'd' }), /sem chave válida/);
  }
});

test('Given negado no navegador Then erro claro e sem chave', async () => {
  const { ctx } = makeCtx({ fetch: deviceServer([pending(), json({ error: 'access_denied' }, { status: 400 })]).fetch });
  await assert.rejects(pollDeviceToken(ctx, AUTH, await requestDeviceCode(ctx, AUTH)), /negado/);
});

test('Given expired_token do servidor ou relógio vencido Then expira', async () => {
  const { ctx } = makeCtx({ fetch: deviceServer([json({ error: 'expired_token' }, { status: 400 })]).fetch });
  await assert.rejects(pollDeviceToken(ctx, AUTH, await requestDeviceCode(ctx, AUTH)), /expirou/);
  const clock = makeCtx({ fetch: deviceServer([pending()]).fetch });
  const auth = await requestDeviceCode(clock.ctx, AUTH);
  clock.advance(600000);
  await assert.rejects(pollDeviceToken(clock.ctx, AUTH, auth), /expirou/);
  assert.deepEqual(clock.lines.waits, []);
  const slow = makeCtx({ fetch: deviceServer([pending()]).fetch });
  const near = { ...(await requestDeviceCode(slow.ctx, AUTH)), expiresAt: slow.ctx.now() + 3000 };
  await assert.rejects(pollDeviceToken(slow.ctx, AUTH, near), /expirou/);
});

test('Given slow_down Then soma 5 s ao intervalo e mantém depois', async () => {
  const { ctx, lines } = makeCtx({ fetch: deviceServer([json({ error: 'slow_down' }, { status: 400 }), pending(), json({ access_token: KEY })]).fetch });
  assert.equal(await pollDeviceToken(ctx, AUTH, await requestDeviceCode(ctx, AUTH)), KEY);
  assert.deepEqual(lines.waits, [5000, 10000, 10000]);
});

test('Given intervalo menor que o piso Then espera ao menos 1 s', async () => {
  const { ctx, lines } = makeCtx({ fetch: deviceServer([json({ access_token: KEY })], json({ ...CODE, interval: 0.1 })).fetch });
  const auth = await requestDeviceCode(ctx, AUTH);
  await pollDeviceToken(ctx, AUTH, auth);
  assert.deepEqual(lines.waits, [1000]);
});

test('Given 429 com Retry-After Then espera o maior entre ele e o intervalo, sem passar da expiração', async () => {
  const limited = seconds => new Response('{}', { status: 429, headers: seconds === undefined ? {} : { 'Retry-After': String(seconds) } });
  const first = makeCtx({ fetch: deviceServer([limited(30), json({ access_token: KEY })]).fetch });
  assert.equal(await pollDeviceToken(first.ctx, AUTH, await requestDeviceCode(first.ctx, AUTH)), KEY);
  assert.deepEqual(first.lines.waits, [5000, 30000, 5000]);
  const noHeader = makeCtx({ fetch: deviceServer([limited(), json({ access_token: KEY })]).fetch });
  await pollDeviceToken(noHeader.ctx, AUTH, await requestDeviceCode(noHeader.ctx, AUTH));
  assert.deepEqual(noHeader.lines.waits, [5000, 5000, 5000]);
  const huge = makeCtx({ fetch: deviceServer([limited(100000), json({ access_token: KEY })]).fetch });
  const auth = { ...(await requestDeviceCode(huge.ctx, AUTH)) };
  auth.expiresAt = huge.ctx.now() + 20000;
  await assert.rejects(pollDeviceToken(huge.ctx, AUTH, auth), /expirou/);
  assert.deepEqual(huge.lines.waits, [5000, 15000, 5000].slice(0, 2));
  const expiring = makeCtx({ fetch: deviceServer([limited(1)]).fetch });
  const quick = { ...(await requestDeviceCode(expiring.ctx, AUTH)), intervalMs: 1000 };
  quick.expiresAt = expiring.ctx.now() + 1500;
  await assert.rejects(pollDeviceToken(expiring.ctx, AUTH, quick), /expirou/);
});

test('Given erro HTTP inesperado na consulta Then falha sem corpo do servidor', async () => {
  const { ctx } = makeCtx({ fetch: deviceServer([json({ error: 'server_error', detail: 'segredo-do-servidor' }, { status: 500 })]).fetch });
  await assert.rejects(pollDeviceToken(ctx, AUTH, await requestDeviceCode(ctx, AUTH)), error => /HTTP 500/.test(error.message) && !error.message.includes('segredo'));
  const text = makeCtx({ fetch: deviceServer([new Response('texto', { status: 400 })]).fetch });
  await assert.rejects(pollOnce(text.ctx, AUTH, { deviceCode: 'd' }), /HTTP 400/);
});

test('Given URLs do servidor Then só abre https do domínio oficial ou loopback; Windows sem cmd.exe', () => {
  assert.equal(isSafeToOpen('https://app.quebragalho.dev/x?y=1&z=2'), 'https://app.quebragalho.dev/x?y=1&z=2');
  assert.equal(isSafeToOpen('https://quebragalho.dev/'), 'https://quebragalho.dev/');
  assert.equal(isSafeToOpen('https://app.quebragalho.dev/x y'), 'https://app.quebragalho.dev/x%20y', 'abre a URL normalizada, nunca a string crua');
  assert.equal(isSafeToOpen('https://app.quebragalho.dev/a\n--x'), 'https://app.quebragalho.dev/a--x');
  for (const loopback of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://[::1]:9/x']) {
    assert.equal(isSafeToOpen(loopback), null, 'loopback só quando o servidor de login também é local');
    assert.equal(isSafeToOpen(loopback, { allowLoopback: true }), new URL(loopback).href);
  }
  for (const bad of ['http://app.quebragalho.dev/', 'https://evil.com/?x=quebragalho.dev', 'https://quebragalho.dev.evil.com/', 'https://u:p@app.quebragalho.dev/', 'file:///etc/passwd', 'javascript:alert(1)', 'nada', '', 'https://notquebragalho.dev']) {
    assert.equal(isSafeToOpen(bad, { allowLoopback: true }), null, bad);
  }
  assert.equal(isSafeToOpen('https://evil.com/', { allowLoopback: true }), null);
  assert.deepEqual(browserCommand('darwin', 'https://x'), { command: '/usr/bin/open', args: ['https://x'] });
  assert.deepEqual(browserCommand('linux', 'https://x'), { command: 'xdg-open', args: ['https://x'] });
  assert.deepEqual(browserCommand('win32', 'https://x/?a=1&b=2', { SystemRoot: 'D:\\Win' }), { command: 'D:\\Win\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://x/?a=1&b=2'] });
  assert.equal(browserCommand('win32', 'https://x').command, 'C:\\Windows\\System32\\rundll32.exe');
  assert.equal(normalizeAuthBase('https://app.quebragalho.dev/api/cli/v1/'), AUTH);
  assert.throws(() => normalizeAuthBase('http://evil.com'), QgError);
  assert.throws(() => normalizeAuthBase('xx'), QgError);
});

function loginCtx(replies, overrides = {}) {
  const server = deviceServer(replies);
  const built = makeCtx({ fetch: server.fetch, isTTY: false, env: { PATH: '' }, ...overrides });
  return { ...built, server };
}

test('Given login aprovado Then mostra código e URL, guarda no cofre e valida a chave no catálogo', async () => {
  const { ctx, lines } = loginCtx([pending(), json({ access_token: KEY })]);
  await loginCommand(ctx, ['--sem-navegador']);
  const text = lines.out.join('\n');
  assert.match(text, /ABCD-1234/);
  assert.match(text, /connect\/cli/);
  assert.match(text, /Login concluído/);
  assert.equal(await ctx.vault.get(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev')), KEY);
  assert.ok(!text.includes(KEY) && !lines.err.join('').includes(KEY));
});

test('Given login negado, expirado ou com chave recusada Then nada é guardado', async () => {
  for (const replies of [[json({ error: 'access_denied' }, { status: 400 })], [json({ error: 'expired_token' }, { status: 400 })]]) {
    const { ctx } = loginCtx(replies);
    await assert.rejects(loginCommand(ctx, ['--sem-navegador']), QgError);
    assert.equal(ctx.vault.items.size, 0);
  }
  const bad = loginCtx([json({ access_token: KEY })]);
  const original = bad.ctx.fetch;
  bad.ctx.fetch = async (url, options) => (new URL(url).pathname === '/v1/models' ? json({ error: 'x' }, { status: 401 }) : original(url, options));
  await assert.rejects(loginCommand(bad.ctx, ['--sem-navegador']), /Chave recusada/);
  assert.equal(bad.ctx.vault.items.size, 0);
});

test('Given TTY e navegador disponível Then tenta abrir só URL segura, sem falhar se não abrir', async () => {
  const { ctx, lines } = loginCtx([json({ access_token: KEY })], { isTTY: true, platform: 'linux' });
  await loginCommand(ctx, []);
  assert.ok(!lines.out.join('\n').includes('Abrindo o navegador'), 'sem xdg-open no PATH: segue sem abrir');
  const evil = deviceServer([json({ access_token: KEY })], json({ ...CODE, verification_uri_complete: 'https://evil.example/?x=quebragalho.dev', verification_uri: 'https://evil.example' }));
  const second = makeCtx({ fetch: evil.fetch, isTTY: true });
  await loginCommand(second.ctx, []);
  assert.ok(!second.lines.out.join('\n').includes('Abrindo o navegador'));
});

test('Given login com chave colada Then valida e guarda; vazia é recusada', async () => {
  const { ctx } = loginCtx([]);
  ctx.ask = async (question, secret) => { assert.equal(secret, true); assert.match(question, /Cole a chave/); return KEY; };
  await loginCommand(ctx, ['--chave']);
  assert.equal(await ctx.vault.get(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev')), KEY);
  ctx.ask = async () => '';
  await assert.rejects(loginCommand(ctx, ['--chave']), /vazia/);
  ctx.ask = async () => 'com espaço';
  await assert.rejects(loginCommand(ctx, ['--chave']), /inválidos/);
});

test('Given prompt vazio no setup (allowEmptyForDevice) Then cai no login por código', async () => {
  const { ctx } = loginCtx([json({ access_token: KEY })]);
  ctx.ask = async question => { assert.match(question, /Enter para entrar por código/); return ''; };
  assert.equal(await obtainKey(ctx, 'https://api.quebragalho.dev', { allowEmptyForDevice: true, openUrl: false }), KEY);
  ctx.ask = async () => KEY;
  assert.equal(await obtainKey(ctx, 'https://api.quebragalho.dev', { allowEmptyForDevice: true }), KEY);
});

test('Given gateway que não é o oficial Then login por código exige QUEBRAGALHO_AUTH_URL ou --chave', async () => {
  const { ctx } = loginCtx([], { env: { PATH: '', QUEBRAGALHO_BASE_URL: 'https://gateway.example' } });
  await assert.rejects(loginCommand(ctx, ['--sem-navegador']), /--chave/);
  const custom = loginCtx([json({ access_token: KEY })], { env: { PATH: '', QUEBRAGALHO_BASE_URL: 'https://gateway.example', QUEBRAGALHO_AUTH_URL: 'https://auth.example/cli' } });
  await loginCommand(custom.ctx, ['--sem-navegador']);
  assert.equal(await custom.ctx.vault.get(LOGIN_SERVICE, loginAccount('https://gateway.example')), KEY);
  assert.equal(await custom.ctx.vault.get(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev')), undefined);
});

test('Given aviso do cofre (arquivo) Then o login mostra o aviso e onde guardou', async () => {
  const vault = memoryVault('file');
  vault.set = async () => ({ kind: 'file', warning: 'AVISO-ARQUIVO' });
  const { ctx, lines } = loginCtx([json({ access_token: KEY })], { vault });
  await loginCommand(ctx, ['--sem-navegador']);
  assert.ok(lines.err.some(line => line.includes('AVISO-ARQUIVO')));
  assert.match(lines.out.join('\n'), /arquivo 0600/);
});

test('Given logout Then remove a chave do cofre e informa; repetido não falha', async () => {
  const { ctx, lines } = loginCtx([]);
  await ctx.vault.set(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev'), KEY);
  await logoutCommand(ctx, []);
  assert.equal(ctx.vault.items.size, 0);
  assert.match(lines.out.at(-1), /Chave removida/);
  await logoutCommand(ctx, []);
  assert.match(lines.out.at(-1), /Nenhuma chave/);
  await assert.rejects(logoutCommand(ctx, ['--x']), /desconhecida/);
});
