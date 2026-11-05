// launch: isolamento dos cinco harnesses, filtro de decisão, Codex sem /v1/responses, aviso de saldo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, CATALOG, KEY, model, tempDir, removeDir } from './helpers.mjs';
import { main } from '../quebragalho.mjs';
import { parseLaunchArgs, LOW_BALANCE_BRL } from '../lib/launch.mjs';
import { isolatedEnv, configuration } from '../lib/harness.mjs';
import { LOGIN_SERVICE, loginAccount } from '../lib/vault.mjs';
import { INSTALL_HINTS } from '../lib/proc.mjs';

const POSIX = { skip: process.platform === 'win32' && 'harnesses falsos POSIX' };
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'); const e = process.env; const args = process.argv.slice(2);
const extension = args.includes('--extension') ? args[args.indexOf('--extension') + 1] : undefined;
fs.writeFileSync(e.CAPTURE, JSON.stringify({ args, configDir: e.CLAUDE_CONFIG_DIR, home: e.HOME, codexHome: e.CODEX_HOME, opencodeDir: e.OPENCODE_CONFIG_DIR,
  opencodeFile: e.OPENCODE_CONFIG, piDir: e.PI_CODING_AGENT_DIR, xdgConfig: e.XDG_CONFIG_HOME, xdgData: e.XDG_DATA_HOME, base: e.ANTHROPIC_BASE_URL,
  token: e.ANTHROPIC_AUTH_TOKEN, api: e.ANTHROPIC_API_KEY, qg: e.QUEBRAGALHO_API_KEY, discovery: e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, bedrock: e.CLAUDE_CODE_USE_BEDROCK,
  openaiBase: e.OPENAI_API_BASE, openaiKey: e.OPENAI_API_KEY, opencode: e.OPENCODE_CONFIG_CONTENT, extension: extension ? fs.readFileSync(extension, 'utf8') : undefined }));
process.exit(7);
`;
const liveRoutes = extra => ({ 'GET /v1/models': json(CATALOG), 'GET /v1/balance': json({ currency: 'BRL', available: '50.00', default: '50', bonus: '0' }),
  'POST /v1/responses': json({}, { status: 400 }), ...extra });

async function fixture(options = {}) {
  const dir = await tempDir('qg-launch-');
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const name of Object.keys(INSTALL_HINTS)) await writeFile(join(bin, name), FAKE, { mode: 0o755 });
  const capture = join(dir, 'capture.json');
  const scratch = join(dir, 'tmp');
  await mkdir(scratch);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const server = router(liveRoutes(options.routes));
  const env = { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, QUEBRAGALHO_API_KEY: KEY, CLAUDE_CODE_USE_BEDROCK: '1',
    CODEX_HOME: '/oficial/codex', OPENCODE_CONFIG_DIR: '/oficial/opencode', OPENCODE_CONFIG: '/oficial/opencode.json', PI_CODING_AGENT_DIR: '/oficial/pi', ...options.env };
  const built = makeCtx({ fetch: server.fetch, env, platform: process.platform, ...options.ctx });
  const read = async () => JSON.parse(await readFile(capture, 'utf8'));
  const leftovers = async () => readdir(scratch);
  const cleanup = () => { process.exitCode = 0; if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; return removeDir(dir); };
  return { dir, bin, capture, server, read, leftovers, ...built, cleanup };
}

test('Given launch de cada harness Then perfil temporário isolado, argumentos literais e limpeza', POSIX, async () => {
  const f = await fixture();
  try {
    const before = await f.leftovers();
    for (const harness of ['claude', 'codex', 'opencode', 'aider', 'pi']) {
      await main(['launch', harness, '--model', 'model-a', '--', '-p', 'olá mundo; $(echo nope)'], f.ctx);
      assert.equal(process.exitCode, 7, harness);
      const captured = await f.read();
      assert.deepEqual(captured.args.slice(-2), ['-p', 'olá mundo; $(echo nope)']);
      assert.equal(captured.qg, ['codex', 'opencode', 'pi'].includes(harness) ? KEY : undefined, harness);
      assert.notEqual(captured.home, process.env.HOME);
      assert.ok(captured.xdgConfig.startsWith(`${captured.home}/`) && captured.xdgData.startsWith(`${captured.home}/`));
      await assert.rejects(stat(captured.home), { code: 'ENOENT' });
      assert.ok(!captured.args.join(' ').includes(KEY), 'a chave nunca vai em argumento');
      if (harness === 'claude') {
        assert.deepEqual(captured.args.slice(0, 2), ['--model', 'model-a']);
        assert.deepEqual([captured.token, captured.api, captured.discovery, captured.bedrock], [KEY, '', '1', undefined]);
        assert.equal(captured.base, 'https://api.quebragalho.dev');
        await assert.rejects(stat(captured.configDir), { code: 'ENOENT' });
      }
      if (harness === 'codex') {
        assert.ok(captured.codexHome.startsWith(`${captured.home}/`));
        for (const item of ['model_provider="quebragalho"', 'model_providers.quebragalho.wire_api="responses"', 'model_providers.quebragalho.env_key="QUEBRAGALHO_API_KEY"', 'model_providers.quebragalho.base_url="https://api.quebragalho.dev/v1"']) assert.ok(captured.args.includes(item), item);
      }
      if (harness === 'aider') {
        assert.deepEqual([captured.openaiBase, captured.openaiKey], ['https://api.quebragalho.dev/v1', KEY]);
        for (const flag of ['--config', '--env-file', '--input-history-file', '--chat-history-file', '--llm-history-file']) assert.ok(captured.args[captured.args.indexOf(flag) + 1].startsWith(`${captured.home}/`));
      }
    }
    assert.deepEqual(await f.leftovers(), before, 'nenhum temporário sobrou');
  } finally { await f.cleanup(); }
});

test('Given OpenCode e Pi Then usam contexto, saída, capacidades e preço do catálogo, com limites conservadores no null', POSIX, async () => {
  const f = await fixture({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { oficial: { name: 'Oficial' } }, theme: 'existente' }) } });
  try {
    await main(['launch', 'opencode', '--model', 'gpt-6-luna', '--', '--help'], f.ctx);
    const config = JSON.parse((await f.read()).opencode);
    assert.equal(config.model, 'quebragalho/gpt-6-luna');
    assert.deepEqual(config.provider.oficial, { name: 'Oficial' });
    assert.equal(config.theme, 'existente');
    assert.deepEqual(Object.keys(config.provider.quebragalho.models), ['gpt-6-luna', 'model-a']);
    assert.deepEqual(config.provider.quebragalho.models['gpt-6-luna'].limit, { context: 200000, output: 32000 });
    assert.equal(config.provider.quebragalho.models['model-a'].limit, undefined);
    assert.equal(config.provider.quebragalho.options.apiKey, '{env:QUEBRAGALHO_API_KEY}');
    await main(['launch', 'pi', '--model', 'model-a'], f.ctx);
    const captured = await f.read();
    let provider;
    (await import(`data:text/javascript,${encodeURIComponent(captured.extension)}`)).default({ registerProvider: (name, value) => { assert.equal(name, 'quebragalho'); provider = value; } });
    assert.equal(provider.apiKey, '$QUEBRAGALHO_API_KEY');
    const luna = provider.models.find(item => item.id === 'gpt-6-luna');
    assert.deepEqual([luna.contextWindow, luna.maxTokens, luna.reasoning, luna.input, luna.cost.input], [200000, 32000, true, ['text', 'image'], 1.25]);
    const plain = provider.models.find(item => item.id === 'model-a');
    assert.deepEqual([plain.contextWindow, plain.maxTokens, plain.reasoning, plain.input], [32768, 4096, false, ['text']]);
    assert.equal(provider.models.length, 2, 'decisão fora da lista do Pi');
  } finally { await f.cleanup(); }
});

test('Given modelo de decisão Then --model recusa com mensagem clara e nenhum harness abre', POSIX, async () => {
  const f = await fixture();
  try {
    await assert.rejects(main(['launch', 'claude', '--model', 'systemone'], f.ctx), /systemone é de decisão.*não faz chat/);
    await assert.rejects(main(['launch', 'claude', '--model', 'decisor-2'], f.ctx), /de decisão/);
    await assert.rejects(main(['launch', 'claude', '--model', 'inexistente'], f.ctx), /não encontrado no catálogo/);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('Given vários modelos sem terminal Then exige --model; com um só, usa-o', POSIX, async () => {
  const f = await fixture();
  try {
    await assert.rejects(main(['launch', 'claude'], f.ctx), /informe --model ID/);
    f.ctx.fetch = router(liveRoutes({ 'GET /v1/models': json({ data: [model('unico'), model('dec', { type: 'decision' })] }) })).fetch;
    await main(['launch', 'claude'], f.ctx);
    assert.deepEqual((await f.read()).args.slice(0, 2), ['--model', 'unico']);
    await assert.rejects(main(['launch'], f.ctx), /Harness inválido/);
    await assert.rejects(main(['launch', 'bogus'], f.ctx), /Harness inválido/);
    await assert.rejects(main(['launch', 'claude', '--model'], f.ctx), /exige um valor/);
    await assert.rejects(main(['launch', 'claude', 'codex'], f.ctx), /demais/);
  } finally { await f.cleanup(); }
});

test('Given gateway sem /v1/responses (404) When launch codex Then falha antes de abrir e sem temporários; --forcar ignora', POSIX, async () => {
  const f = await fixture({ routes: { 'POST /v1/responses': json({ error: 'not found' }, { status: 404 }) } });
  try {
    const before = await f.leftovers();
    await assert.rejects(main(['launch', 'codex', '--model', 'model-a'], f.ctx), error => /\/v1\/responses/.test(error.message) && /--forcar/.test(error.message));
    assert.deepEqual(await f.leftovers(), before);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    assert.equal(f.server.calls.find(call => call.route === 'POST /v1/responses').options.body, undefined);
    await main(['launch', 'codex', '--model', 'model-a', '--forcar'], f.ctx);
    assert.equal(process.exitCode, 7);
    assert.ok((await f.read()).args.includes('model_provider="quebragalho"'));
    assert.equal(f.server.calls.filter(call => call.route === 'POST /v1/responses').length, 1, 'com --forcar nem sonda');
    await main(['launch', 'claude', '--model', 'model-a'], f.ctx);
    assert.equal(f.server.calls.filter(call => call.route === 'POST /v1/responses').length, 1, 'só o Codex sonda');
  } finally { await f.cleanup(); }
});

test('Given sonda do Codex com erro de rede ou 401 Then segue (só 404 bloqueia)', POSIX, async () => {
  for (const reply of [() => { throw new TypeError('rede'); }, () => json({}, { status: 401 })]) {
    const f = await fixture({ routes: { 'POST /v1/responses': reply } });
    try { await main(['launch', 'codex', '--model', 'model-a'], f.ctx); assert.equal(process.exitCode, 7); }
    finally { await f.cleanup(); }
  }
});

test('Given saldo zerado, baixo, ok ou ilegível Then avisa antes de abrir sem bloquear, e só no stderr', POSIX, async () => {
  for (const [balance, expected] of [[{ available: '0.00' }, /saldo zerado \(R\$ 0,00\)/], [{ available: '-1.5' }, /saldo zerado/], [{ available: '2.349' }, /saldo baixo \(R\$ 2,35\)/], [{ available: String(LOW_BALANCE_BRL) }, null], [{ available: 'abc' }, null]]) {
    const f = await fixture({ routes: { 'GET /v1/balance': json({ currency: 'BRL', default: '0', bonus: '0', ...balance }) } });
    try {
      await main(['launch', 'claude', '--model', 'model-a'], f.ctx);
      assert.equal(process.exitCode, 7);
      if (expected) assert.match(f.lines.err.join('\n'), expected); else assert.deepEqual(f.lines.err, []);
      assert.deepEqual(f.lines.out, []);
    } finally { await f.cleanup(); }
  }
  for (const routes of [{ 'GET /v1/balance': json({}, { status: 500 }) }, { 'GET /v1/balance': () => { throw new TypeError('rede'); } }]) {
    const f = await fixture({ routes });
    try { await main(['launch', 'claude', '--model', 'model-a'], f.ctx); assert.equal(process.exitCode, 7); assert.deepEqual(f.lines.err, []); }
    finally { await f.cleanup(); }
  }
});

test('Given harness ausente Then diz o comando oficial de instalação, sem rede e sem temporários', POSIX, async () => {
  const f = await fixture({ env: { PATH: '/nao/existe' } });
  try {
    for (const harness of Object.keys(INSTALL_HINTS)) await assert.rejects(main(['launch', harness, '--model', 'x'], f.ctx), error => error.message.includes(INSTALL_HINTS[harness]));
    assert.equal(f.server.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('Given login no cofre e sem variável Then o harness recebe a chave do cofre', POSIX, async () => {
  const f = await fixture({ env: { QUEBRAGALHO_API_KEY: '' } });
  try {
    await assert.rejects(main(['launch', 'claude', '--model', 'model-a'], f.ctx), /quebragalho login/);
    await f.ctx.vault.set(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev'), 'chave-do-cofre');
    await main(['launch', 'claude', '--model', 'model-a'], f.ctx);
    const captured = await f.read();
    assert.deepEqual([captured.token, captured.qg], ['chave-do-cofre', undefined]);
    await main(['launch', 'pi', '--model', 'model-a'], f.ctx);
    assert.equal((await f.read()).qg, 'chave-do-cofre');
    assert.equal(f.server.calls[0].options.headers.Authorization, 'Bearer chave-do-cofre');
  } finally { await f.cleanup(); }
});

test('Given Windows Then HOME, USERPROFILE, APPDATA e LOCALAPPDATA ficam no diretório temporário', POSIX, async () => {
  const { env, directories } = isolatedEnv({ USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\x', Path: 'p' }, '/tmp/t', 'win32');
  assert.deepEqual([env.HOME, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA], ['/tmp/t', '/tmp/t', '/tmp/t/appdata', '/tmp/t/localappdata']);
  assert.equal(env.Path, 'p');
  assert.ok(directories.includes('/tmp/t/appdata') && directories.includes('/tmp/t/localappdata'));
  const unix = isolatedEnv({ USERPROFILE: 'C:\\Users\\a' }, '/tmp/t', 'linux');
  assert.equal(unix.env.USERPROFILE, 'C:\\Users\\a');
  assert.equal(unix.directories.length, 4);
  const f = await fixture({ ctx: { platform: 'win32' } });
  try {
    const result = await configuration(f.ctx, 'aider', { base: 'https://x.dev', key: KEY, model: 'm', models: [] });
    assert.ok((await stat(result.env.LOCALAPPDATA)).isDirectory() && (await stat(result.env.APPDATA)).isDirectory());
    await removeDir(result.temporary);
  } finally { await f.cleanup(); }
});

test('Given configuração que falha Then remove o temporário', POSIX, async () => {
  const f = await fixture({ env: { OPENCODE_CONFIG_CONTENT: '{inválido' } });
  try {
    const before = await f.leftovers();
    await assert.rejects(main(['launch', 'opencode', '--model', 'model-a'], f.ctx), /OPENCODE_CONFIG_CONTENT/);
    assert.deepEqual(await f.leftovers(), before);
  } finally { await f.cleanup(); }
});

test('parseLaunchArgs separa opções do harness e dos argumentos encaminhados', () => {
  assert.deepEqual(parseLaunchArgs(['codex', '--model', 'm', '--forcar', '--', '--model', 'x', '--forcar']), { harness: 'codex', model: 'm', force: true, forwarded: ['--model', 'x', '--forcar'] });
  assert.deepEqual(parseLaunchArgs([]), { harness: undefined, model: undefined, force: false, forwarded: [] });
});

test('Given quebragalho claude Then usa o perfil QG, sem variáveis herdadas de provedor', POSIX, async () => {
  const f = await fixture({ env: { XDG_CONFIG_HOME: '', ANTHROPIC_API_KEY: 'oficial', CLAUDE_CODE_USE_VERTEX: '1' } });
  try {
    f.ctx.env.XDG_CONFIG_HOME = join(f.dir, 'xdg');
    await assert.rejects(main(['claude', '-p', 'x'], f.ctx), /setup claude/);
    const profile = join(f.dir, 'xdg', 'quebragalho', 'claude');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'settings.json'), '{}');
    await main(['claude', '-p', 'x'], f.ctx);
    const captured = await f.read();
    assert.equal(captured.configDir, profile);
    assert.equal(captured.api, undefined);
    assert.deepEqual(captured.args, ['-p', 'x']);
    f.ctx.env.PATH = '/nao/existe';
    await assert.rejects(main(['claude'], f.ctx), /npm install -g @anthropic-ai\/claude-code/);
  } finally { await f.cleanup(); }
});
