// setup claude em todos os SOs (cofre simulado): perfil isolado, apiKeyHelper, chave fora do settings.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, memoryVault, CATALOG, KEY, tempDir, removeDir } from './helpers.mjs';
import { main } from '../quebragalho.mjs';
import { helperCommand, claudeProfile } from '../lib/claude-setup.mjs';
import { CLAUDE_SERVICE, LOGIN_SERVICE, loginAccount } from '../lib/vault.mjs';

const ACCOUNT = /claude-[0-9a-f]{64}/;
const ORIGINAL = JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ['Read(private)'] }, env: { KEEP: 'yes', ANTHROPIC_AUTH_TOKEN: 'antigo', CLAUDE_CODE_USE_BEDROCK: '1' } });

async function fixture(options = {}) {
  const dir = await tempDir('qg-setup-');
  const server = router({ 'GET /v1/models': json(CATALOG), ...options.routes });
  const platform = options.platform ?? 'linux';
  const env = { XDG_CONFIG_HOME: join(dir, 'xdg'), APPDATA: join(dir, 'appdata'), PATH: '', QUEBRAGALHO_API_KEY: KEY, ...options.env };
  const built = makeCtx({ fetch: server.fetch, env, platform, homedir: () => join(dir, 'home'), capture: () => 'Claude Code 2.1.286', ...options.ctx });
  const profile = claudeProfile(built.ctx);
  const settings = join(profile, 'settings.json');
  if (options.original !== undefined) { await mkdir(profile, { recursive: true }); await writeFile(settings, options.original); }
  return { dir, profile, settings, server, ...built, read: async () => JSON.parse(await readFile(settings, 'utf8')) };
}

test('Given macOS Then mesmo item do Chaves e mesmo apiKeyHelper de antes, sem a chave no settings.json', async () => {
  const f = await fixture({ platform: 'darwin', original: ORIGINAL, ctx: { vault: memoryVault() } });
  try {
    await main(['setup', 'claude'], f.ctx);
    const configured = await f.read();
    const account = ACCOUNT.exec(configured.apiKeyHelper)[0];
    assert.equal(configured.apiKeyHelper, `/usr/bin/security find-generic-password -a ${account} -s dev.quebragalho.claude -w`);
    assert.equal(f.ctx.vault.items.get(`${CLAUDE_SERVICE}/${account}`), KEY);
    assert.ok(!(await readFile(f.settings, 'utf8')).includes(KEY));
    assert.deepEqual(configured.hooks, { Stop: [] });
    assert.deepEqual(configured.permissions, { deny: ['Read(private)'] });
    assert.equal(configured.env.KEEP, 'yes');
    assert.deepEqual([configured.env.ANTHROPIC_BASE_URL, configured.env.ANTHROPIC_API_KEY, configured.env.ANTHROPIC_AUTH_TOKEN, configured.env.CLAUDE_CODE_USE_BEDROCK], ['https://api.quebragalho.dev', '', '', '0']);
    assert.deepEqual([configured.model, configured.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, configured.env.ANTHROPIC_DEFAULT_SONNET_MODEL], ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna']);
    assert.deepEqual(configured.modelPicker.options.map(row => row.model), ['gpt-6-luna', 'model-a']);
    assert.equal(configured.modelPicker.replaceBuiltInOptions, true);
    if (process.platform !== 'win32') assert.equal((await stat(f.settings)).mode & 0o777, 0o600);
    const [backup] = (await readdir(f.profile)).filter(name => name.startsWith('settings.json.quebragalho-backup-'));
    assert.equal(await readFile(join(f.profile, backup), 'utf8'), ORIGINAL);
    assert.match(f.lines.out.join('\n'), /Pronto: 2 modelos/);
    assert.ok(!f.lines.out.join('').includes(KEY));
  } finally { await removeDir(f.dir); }
});

test('Given Linux ou Windows Then apiKeyHelper chama o próprio launcher com subcomando interno', async () => {
  for (const [platform, launcher, expected] of [
    ['linux', "/home/u s/.local/bin/quebragalho", "'/home/u s/.local/bin/quebragalho'"],
    ['freebsd', "/home/o'neil/bin/quebragalho", "'/home/o'\\''neil/bin/quebragalho'"],
    ['win32', 'C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\quebragalho\\quebragalho.cmd', '"C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\quebragalho\\quebragalho.cmd"'],
  ]) {
    const f = await fixture({ platform, env: { QUEBRAGALHO_LAUNCHER: launcher }, ctx: { vault: memoryVault('file') } });
    try {
      await main(['setup', 'claude'], f.ctx);
      const configured = await f.read();
      const account = ACCOUNT.exec(configured.apiKeyHelper)[0];
      assert.equal(configured.apiKeyHelper, `${expected} __key ${account}`, platform);
      assert.equal(f.ctx.vault.items.get(`${CLAUDE_SERVICE}/${account}`), KEY);
      assert.ok(!(await readFile(f.settings, 'utf8')).includes(KEY));
      if (platform === 'win32') assert.ok(f.profile.startsWith(join(f.dir, 'appdata', 'quebragalho')));
      else assert.ok(f.profile.startsWith(join(f.dir, 'xdg', 'quebragalho')));
    } finally { await removeDir(f.dir); }
  }
});

test('Given launcher desconhecido Then helper usa node com o script entre aspas', () => {
  const ctx = { env: {}, platform: 'linux' };
  assert.equal(helperCommand(ctx, 'claude-x', '/a b/quebragalho.mjs'), "node '/a b/quebragalho.mjs' __key claude-x");
  assert.equal(helperCommand({ env: { QUEBRAGALHO_LAUNCHER: '' }, platform: 'win32' }, 'claude-x', 'C:\\a b\\q.mjs'), 'node "C:\\a b\\q.mjs" __key claude-x');
  assert.throws(() => helperCommand({ env: { QUEBRAGALHO_LAUNCHER: 'C:\\a"b\\q.cmd' }, platform: 'win32' }, 'claude-x', 'x'), /aspas/);
});

test('Given apiKeyHelper gravado Then __key imprime só a chave do perfil e recusa outras contas', async () => {
  const f = await fixture({ ctx: { vault: memoryVault('file') } });
  const written = [];
  const original = process.stdout.write;
  try {
    await main(['setup', 'claude'], f.ctx);
    const account = ACCOUNT.exec((await f.read()).apiKeyHelper)[0];
    process.stdout.write = chunk => { written.push(String(chunk)); return true; };
    await main(['__key', account], f.ctx);
    process.stdout.write = original;
    assert.deepEqual(written, [`${KEY}\n`]);
    await f.ctx.vault.set(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev'), 'login-key');
    await assert.rejects(main(['__key', `claude-${'0'.repeat(64)}`], f.ctx), /não encontrada/);
    await assert.rejects(main(['__key', 'login-abc'], f.ctx), /interno/);
    await assert.rejects(main(['__key', account, 'extra'], f.ctx), /interno/);
  } finally { process.stdout.write = original; await removeDir(f.dir); }
});

test('Given reconfiguração com o mesmo perfil e chave Then mantém o modelo escolhido e o mesmo item do cofre', async () => {
  const f = await fixture({ ctx: { vault: memoryVault('file') } });
  try {
    await main(['setup', 'claude'], f.ctx);
    const first = await f.read();
    await writeFile(f.settings, JSON.stringify({ ...first, model: 'model-a' }));
    await main(['setup', 'claude'], f.ctx);
    const second = await f.read();
    assert.equal(second.model, 'model-a');
    assert.equal(second.apiKeyHelper, first.apiKeyHelper);
    assert.equal(f.ctx.vault.items.size, 1);
    const other = await fixture({ ctx: { vault: memoryVault('file') }, env: { XDG_CONFIG_HOME: join(f.dir, 'outro') } });
    try {
      await main(['setup', 'claude'], other.ctx);
      assert.notEqual((await other.read()).apiKeyHelper, first.apiKeyHelper);
    } finally { await removeDir(other.dir); }
  } finally { await removeDir(f.dir); }
});

test('Given falhas Then o settings.json fica byte a byte igual e a mensagem não vaza a chave', async () => {
  const cases = [
    ['cofre falha', { ctx: { vault: { ...memoryVault(), set: async () => { throw new Error(KEY); } } } }, /guardar a chave no cofre/],
    ['cofre com mensagem própria', { ctx: { vault: { ...memoryVault(), set: async () => { throw new (await import('../lib/util.mjs')).QgError('DPAPI falhou'); } } } }, /DPAPI falhou.*preservada/],
    ['catálogo recusa', { routes: { 'GET /v1/models': json({}, { status: 401 }) } }, /Chave recusada/],
    ['Claude antigo', { ctx: { capture: () => '2.1.100' } }, /Atualize Claude Code/],
    ['Claude 2.0', { ctx: { capture: () => '2.0.999' } }, /Atualize Claude Code/],
    ['Claude 1.x', { ctx: { capture: () => '1.9.9' } }, /Atualize Claude Code/],
    ['Claude sem versão', { ctx: { capture: () => 'sem número' } }, /Atualize Claude Code/],
    ['Claude ausente', { ctx: { capture: () => { throw new Error('x'); } } }, /Instale Claude Code 2\.1\.242\+.*npm install/],
    ['chave inválida', { env: { QUEBRAGALHO_API_KEY: 'com espaço' } }, /inválidos/],
  ];
  for (const [name, options, pattern] of cases) {
    const f = await fixture({ original: ORIGINAL, ...options, ctx: { vault: memoryVault(), ...options.ctx } });
    try {
      await assert.rejects(main(['setup', 'claude'], f.ctx), error => pattern.test(error.message) && !error.message.includes(KEY), name);
      assert.equal(await readFile(f.settings, 'utf8'), ORIGINAL, name);
      assert.deepEqual((await readdir(f.profile)).sort(), ['settings.json'], `${name}: sem temporários nem backup`);
    } finally { await removeDir(f.dir); }
  }
  for (const invalid of ['JSON inválido', '[]', '{"env": 3}', 'null']) {
    const f = await fixture({ original: invalid });
    try {
      await assert.rejects(main(['setup', 'claude'], f.ctx), /objeto JSON válido/);
      assert.equal(await readFile(f.settings, 'utf8'), invalid);
    } finally { await removeDir(f.dir); }
  }
});

test('Given settings.json alterado durante o setup Then aborta sem sobrescrever', async () => {
  const f = await fixture({ original: ORIGINAL });
  try {
    const vault = memoryVault();
    vault.set = async () => { await writeFile(f.settings, '{"concorrente":true}'); return {}; };
    f.ctx.vault = vault;
    await assert.rejects(main(['setup', 'claude'], f.ctx), /mudou durante o setup/);
    assert.equal(await readFile(f.settings, 'utf8'), '{"concorrente":true}');
    assert.deepEqual((await readdir(f.profile)).sort(), ['settings.json']);
  } finally { await removeDir(f.dir); }
});

test('Given sem variável Then usa a chave do login do cofre; sem nada, oferece login por código ou chave colada', async () => {
  const f = await fixture({ env: { QUEBRAGALHO_API_KEY: '' }, ctx: { vault: memoryVault('file') } });
  try {
    await f.ctx.vault.set(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev'), 'chave-do-login');
    await main(['setup', 'claude'], f.ctx);
    assert.equal(f.server.calls[0].options.headers.Authorization, 'Bearer chave-do-login');
    const empty = await fixture({ env: { QUEBRAGALHO_API_KEY: '' }, ctx: { vault: memoryVault('file'), isTTY: true } });
    try {
      empty.ctx.ask = async (question, secret) => { assert.equal(secret, true); return KEY; };
      await main(['setup', 'claude', '--sem-navegador'], empty.ctx);
      assert.equal(empty.server.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
    } finally { await removeDir(empty.dir); }
  } finally { await removeDir(f.dir); }
});

test('Given cofre em arquivo Then o aviso aparece e o setup informa onde a chave ficou', async () => {
  const vault = memoryVault('file');
  vault.set = async () => ({ kind: 'file', warning: 'AVISO-0600' });
  const f = await fixture({ ctx: { vault } });
  try {
    await main(['setup', 'claude'], f.ctx);
    assert.ok(f.lines.err.some(line => line.includes('AVISO-0600')));
    assert.match(f.lines.out.join('\n'), /Chave guardada em: arquivo 0600\./);
  } finally { await removeDir(f.dir); }
});

test('Given Claude sem profile existente Then cria o diretório 0700 e não deixa backup', async () => {
  const f = await fixture({ ctx: { vault: memoryVault('file') } });
  try {
    await main(['setup', 'claude'], f.ctx);
    if (process.platform !== 'win32') assert.equal((await stat(f.profile)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(f.profile)).sort(), ['settings.json']);
  } finally { await removeDir(f.dir); }
});
