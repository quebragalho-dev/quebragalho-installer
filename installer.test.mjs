// Ponta a ponta: instaladores (clone, curl | sh, reinstalação) e o launcher instalado, com a rede simulada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, readlink, readdir, stat, mkdir, cp, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const HARNESSES = ['claude', 'codex', 'opencode', 'aider', 'pi'];
const POSIX = { skip: process.platform === 'win32' && 'usa sh e launchers POSIX' };
const DASHES = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

function run(command, args, env, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function installDirs() {
  const dir = await mkdtemp(join(tmpdir(), 'quebragalho-test-'));
  const home = join(dir, 'home');
  await mkdir(home);
  const env = { HOME: home, QUEBRAGALHO_BIN_DIR: join(dir, 'bin'), QUEBRAGALHO_NO_PROMPT: '1', XDG_DATA_HOME: '', XDG_CONFIG_HOME: join(dir, 'xdg'), QUEBRAGALHO_VAULT: 'file', PATH: process.env.PATH };
  return { dir, home, env, launcher: join(dir, 'bin', 'quebragalho'), app: join(home, '.local', 'share', 'quebragalho') };
}

const sourceFiles = async () => ['quebragalho.mjs', ...(await readdir(join(REPO, 'lib'))).filter(name => name.endsWith('.mjs')).map(name => `lib/${name}`)].sort();

async function copySources(raw) {
  await mkdir(raw);
  for (const file of await sourceFiles()) { await mkdir(dirname(join(raw, file)), { recursive: true }); await cp(join(REPO, file), join(raw, file)); }
}

test('manifesto dos instaladores lista exatamente os arquivos do launcher', async () => {
  const expected = await sourceFiles();
  const shell = /^FILES='([^']+)'/m.exec(await readFile(join(REPO, 'install.sh'), 'utf8'))[1].split(' ').sort();
  const powershell = [...(/\$files = ([^\n]+)/.exec(await readFile(join(REPO, 'install.ps1'), 'utf8'))[1]).matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(shell, expected);
  assert.deepEqual(powershell, expected);
  const ps1 = await readFile(join(REPO, 'install.ps1'));
  assert.ok(ps1.every(byte => byte < 128), 'install.ps1 é ASCII puro (acentos como escapes)');
  for (const file of ['install.sh', 'install.ps1', 'quebragalho.mjs', ...expected, 'README.md', 'docs/VALIDACAO.md']) {
    const content = await readFile(join(REPO, file), 'utf8');
    assert.ok(DASHES.every(dash => !content.includes(dash)), `${file} sem travessão`);
  }
});

test('install.sh de um clone instala, é idempotente e atualiza só o que é nosso', POSIX, async () => {
  const { dir, env, launcher, app } = await installDirs();
  try {
    const first = await run('sh', ['install.sh'], env, { cwd: REPO });
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /Instalado em/);
    assert.match(first.output, /Próximo passo: quebragalho login/);
    assert.equal((await stat(launcher)).mode & 0o111, 0o111);
    assert.ok((await readFile(launcher, 'utf8')).includes('quebragalho-installer:managed'));
    assert.deepEqual((await readdir(app)).sort(), ['.managed', 'lib', 'quebragalho.mjs']);
    assert.deepEqual((await readdir(dirname(app))).filter(name => name.startsWith('.quebragalho')), [], 'sem estágio nem backup');
    assert.equal((await run(launcher, ['--help'], env)).code, 0);
    assert.deepEqual((await run(launcher, ['list'], env)).output.trim().split('\n'), HARNESSES);
    // Reinstalar atualiza: um arquivo adulterado volta ao original.
    await writeFile(join(app, 'quebragalho.mjs'), '// adulterado\n');
    await writeFile(join(app, 'lib', 'velho.mjs'), '// sobra de versão antiga\n');
    const second = await run('sh', ['install.sh'], env, { cwd: REPO });
    assert.equal(second.code, 0, second.output);
    assert.equal(await readFile(join(app, 'quebragalho.mjs'), 'utf8'), await readFile(join(REPO, 'quebragalho.mjs'), 'utf8'));
    await assert.rejects(stat(join(app, 'lib', 'velho.mjs')));
    assert.equal((await run(launcher, ['list'], env)).code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('install.sh preserva arquivo alheio, link simbólico e diretório alheio', POSIX, async () => {
  const { dir, env, launcher, app } = await installDirs();
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(launcher, '#!/bin/sh\necho meu proprio quebragalho\n', { mode: 0o755 });
    const alien = await run('sh', ['install.sh'], env, { cwd: REPO });
    assert.equal(alien.code, 1);
    assert.match(alien.output, /não é do Quebra-galho/);
    assert.equal(await readFile(launcher, 'utf8'), '#!/bin/sh\necho meu proprio quebragalho\n');
    await assert.rejects(stat(app), 'nada instalado quando o launcher é alheio');
    await rm(launcher);
    const missing = join(dir, 'missing');
    await symlink(missing, launcher);
    assert.equal((await run('sh', ['install.sh'], env, { cwd: REPO })).code, 1);
    assert.equal(await readlink(launcher), missing);
    await rm(launcher);
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'dados-do-usuario.txt'), 'meu');
    const foreign = await run('sh', ['install.sh'], env, { cwd: REPO });
    assert.equal(foreign.code, 1);
    assert.match(foreign.output, /QUEBRAGALHO_HOME/);
    assert.equal(await readFile(join(app, 'dados-do-usuario.txt'), 'utf8'), 'meu');
    await assert.rejects(lstat(launcher));
    await rm(join(app, 'dados-do-usuario.txt'));
    assert.equal((await run('sh', ['install.sh'], env, { cwd: REPO })).code, 0, 'diretório vazio é aceito');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('install.sh substitui o launcher antigo de arquivo único, que era nosso', POSIX, async () => {
  const { dir, env, launcher } = await installDirs();
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(launcher, "#!/usr/bin/env node\nimport { spawn, execFileSync } from 'node:child_process';\nconst harnesses = ['claude', 'codex', 'opencode', 'aider', 'pi'];\n", { mode: 0o755 });
    const result = await run('sh', ['install.sh'], env, { cwd: REPO });
    assert.equal(result.code, 0, result.output);
    assert.ok((await readFile(launcher, 'utf8')).includes('quebragalho-installer:managed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Given curl | sh sem clone Then baixa só os arquivos do launcher e instala; funciona com espaços e aspas no caminho', POSIX, async () => {
  const { dir, env } = await installDirs();
  try {
    const raw = join(dir, 'raw');
    await copySources(raw);
    const spaced = join(dir, "pasta com 'aspas'", 'bin');
    const remote = { ...env, QUEBRAGALHO_BIN_DIR: spaced, QUEBRAGALHO_HOME: join(dir, 'app dir'), QUEBRAGALHO_RAW_URL: pathToFileURL(raw).href };
    const script = await readFile(join(REPO, 'install.sh'), 'utf8');
    const piped = await run('sh', [], remote, { input: script, cwd: dir });
    assert.equal(piped.code, 0, piped.output);
    const listed = await run(join(spaced, 'quebragalho'), ['list'], remote);
    assert.deepEqual(listed.output.trim().split('\n'), HARNESSES, listed.output);
    assert.deepEqual((await readdir(join(dir, 'app dir'))).sort(), ['.managed', 'lib', 'quebragalho.mjs']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Given download que falha no meio Then aborta sem launcher, sem app e sem arquivo parcial', POSIX, async () => {
  const { dir, env, home } = await installDirs();
  try {
    const raw = join(dir, 'raw');
    await copySources(raw);
    await rm(join(raw, 'lib', 'vault.mjs'));
    const script = await readFile(join(REPO, 'install.sh'), 'utf8');
    const remote = { ...env, QUEBRAGALHO_RAW_URL: pathToFileURL(raw).href };
    const failed = await run('sh', [], remote, { input: script, cwd: dir });
    assert.equal(failed.code, 1);
    assert.match(failed.output, /Falha ao baixar lib\/vault\.mjs; nada foi instalado/);
    await assert.rejects(lstat(join(dir, 'bin', 'quebragalho')));
    const share = join(home, '.local', 'share');
    assert.deepEqual(await readdir(share), [], 'nem diretório de estágio sobrou');
    assert.deepEqual(await readdir(join(dir, 'bin')), [], 'nem wrapper temporário');
    await writeFile(join(raw, 'lib', 'vault.mjs'), '');
    const empty = await run('sh', [], remote, { input: script, cwd: dir });
    assert.equal(empty.code, 1);
    assert.match(empty.output, /Arquivo vazio: lib\/vault\.mjs/);
    assert.deepEqual(await readdir(share), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('install.sh recusa Node antigo e ausente', POSIX, async () => {
  const { dir, env } = await installDirs();
  try {
    const bin = join(dir, 'fakebin');
    await mkdir(bin);
    await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const old = await run('/bin/sh', ['install.sh'], { ...env, PATH: `${bin}:/usr/bin:/bin` }, { cwd: REPO });
    assert.equal(old.code, 1);
    assert.match(old.output, /Requer Node\.js 22\+/);
    const none = await run('/bin/sh', ['install.sh'], { ...env, PATH: '/nao-existe' }, { cwd: REPO });
    assert.equal(none.code, 1);
    assert.match(none.output, /Instale Node\.js 22\+/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const PRELOAD = `
  globalThis.fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (process.env.MOCK_NETWORK_ERROR) throw new TypeError('test-secret');
    if (pathname === '/v1/models') {
      if (options.headers?.Authorization !== 'Bearer test-secret') return new Response('{}', { status: 401 });
      return new Response(process.env.MOCK_BODY || JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: Number(process.env.MOCK_STATUS || 200) });
    }
    if (pathname === '/v1/balance') return new Response(JSON.stringify({ currency: 'BRL', available: '10.00', default: '10', bonus: '0' }), { status: 200 });
    return new Response('{}', { status: 400 });
  };
`;
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'); const e = process.env; const args = process.argv.slice(2);
fs.writeFileSync(e.CAPTURE, JSON.stringify({ args, home: e.HOME, configDir: e.CLAUDE_CONFIG_DIR, token: e.ANTHROPIC_AUTH_TOKEN }));
if (e.MOCK_SIGNAL) process.kill(process.pid, 'SIGTERM'); else if (e.MOCK_WAIT) setInterval(() => {}, 1000); else process.exit(7);
`;

test('launcher instalado: argumentos literais, código de saída, sinais, limpeza e erros sem vazar a chave', POSIX, async () => {
  const { dir, env, launcher, home } = await installDirs();
  try {
    assert.equal((await run('sh', ['install.sh'], env, { cwd: REPO })).code, 0);
    const preload = join(dir, 'transport.mjs');
    await writeFile(preload, PRELOAD);
    const fakeBin = join(dir, 'fakebin');
    await mkdir(fakeBin);
    for (const name of HARNESSES) await writeFile(join(fakeBin, name), FAKE, { mode: 0o755 });
    const official = join(home, '.claude', 'settings.json');
    await mkdir(dirname(official), { recursive: true });
    await writeFile(official, 'configuração-oficial');
    const capture = join(dir, 'capture.json');
    const full = { ...env, PATH: `${fakeBin}:${process.env.PATH}`, CAPTURE: capture, NODE_OPTIONS: `--import=${preload}`, QUEBRAGALHO_API_KEY: 'test-secret' };
    const result = await run(launcher, ['launch', 'claude', '--model', 'model-b', '--', '-p', 'hello world; $(echo nope)'], full);
    assert.equal(result.code, 7, result.output);
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(captured.args, ['--model', 'model-b', '-p', 'hello world; $(echo nope)']);
    assert.equal(captured.token, 'test-secret');
    await assert.rejects(stat(captured.home), { code: 'ENOENT' });
    const signaled = await run(launcher, ['launch', 'pi', '--model', 'model-b'], { ...full, MOCK_SIGNAL: '1' });
    assert.equal(signaled.signal, 'SIGTERM');
    await assert.rejects(stat(JSON.parse(await readFile(capture, 'utf8')).home), { code: 'ENOENT' });
    await rm(capture);
    const running = spawn(launcher, ['launch', 'pi', '--model', 'model-b'], { env: { ...process.env, ...full, MOCK_WAIT: '1' }, stdio: 'ignore' });
    try {
      const closed = new Promise(resolve => running.on('close', (code, signal) => resolve({ code, signal })));
      let active;
      for (let i = 0; i < 150 && !active; i++) {
        try { active = JSON.parse(await readFile(capture, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
      }
      assert.ok(active, 'o harness iniciou');
      running.kill('SIGTERM');
      assert.equal((await closed).signal, 'SIGTERM');
      await assert.rejects(stat(active.home), { code: 'ENOENT' });
    } finally { running.kill('SIGKILL'); }
    for (const [args, overrides] of [
      [['launch', 'claude'], {}], [['launch', 'claude', '--model', 'missing'], {}], [['launch', 'claude'], { QUEBRAGALHO_API_KEY: '' }],
      [['launch', 'claude'], { QUEBRAGALHO_BASE_URL: 'http://example.com' }], [['launch', 'bogus'], {}],
      [['launch', 'claude'], { QUEBRAGALHO_BASE_URL: 'https://user:pass@gateway.example' }],
      [['launch', 'claude', '--model', 'model-a'], { MOCK_NETWORK_ERROR: '1' }], [['launch', 'claude', '--model', 'model-a'], { MOCK_BODY: '{"data":[]}' }],
      [['launch', 'claude', '--model', 'model-a'], { MOCK_BODY: 'invalid JSON' }], [['launch', 'claude', '--model', 'model-a'], { MOCK_STATUS: '401' }],
      [['launch', 'claude', '--model', 'model-a'], { PATH: dirname(process.execPath) }],
    ]) {
      const failure = await run(launcher, args, { ...full, ...overrides });
      assert.equal(failure.code, 1, `${args.join(' ')} ${JSON.stringify(overrides)}: ${failure.output}`);
      assert.ok(!failure.output.includes('test-secret'));
    }
    assert.equal(await readFile(official, 'utf8'), 'configuração-oficial');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('smoke de CI: --help, list e doctor --json funcionam sem rede nem chave', POSIX, async () => {
  const { dir, env, launcher } = await installDirs();
  try {
    assert.equal((await run('sh', ['install.sh'], env, { cwd: REPO })).code, 0);
    const preload = join(dir, 'offline.mjs');
    await writeFile(preload, "globalThis.fetch = async () => { throw new TypeError('offline'); };\n");
    const offline = { ...env, NODE_OPTIONS: `--import=${preload}` };
    assert.equal((await run(launcher, ['--help'], offline)).code, 0);
    assert.deepEqual((await run(launcher, ['list'], offline)).output.trim().split('\n'), HARNESSES);
    const doctor = await run(launcher, ['doctor', '--json'], offline);
    assert.equal(doctor.code, 0, doctor.output);
    const report = JSON.parse(doctor.output);
    assert.equal(report.ok, true);
    assert.ok(report.checks.some(check => check.id === 'node' && check.status === 'ok'));
    assert.match(report.checks.find(check => check.id === 'path').detail, /launcher/);
    const unknown = await run(launcher, ['nada'], offline);
    assert.equal(unknown.code, 1);
    assert.match(unknown.output, /Comando desconhecido/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows real: .cmd com argumentos hostis chega intacto (só roda no Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { spawnPlan } = await import('./lib/proc.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'qg win espaço-'));
  try {
    await writeFile(join(dir, 'dump.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DUMP, JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(join(dir, 'tool.cmd'), '@echo off\r\nnode "%~dp0dump.mjs" %*\r\n');
    const args = ['simples', 'com espaço', 'aspas "duplas"', 'a&b', 'a|b', '100%', '%PATH%', '^caret', 'a<b>c', '(x)', 'fim\\', '\\"', '"& calc.exe &"', '', '!var!', 'ç é ã'];
    const dump = join(dir, 'out.json');
    const plan = spawnPlan(join(dir, 'tool.cmd'), args, { env: process.env, platform: 'win32' });
    const result = await new Promise(resolve => spawn(plan.command, plan.args, { ...plan.options, env: { ...process.env, DUMP: dump }, stdio: 'ignore', shell: false }).on('close', resolve));
    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(await readFile(dump, 'utf8')), args);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows real: DPAPI guarda e lê (só roda no Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { createContext } = await import('./lib/context.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'qg-dpapi-'));
  try {
    const ctx = createContext({ env: { ...process.env, APPDATA: dir } });
    await ctx.vault.set('dev.quebragalho.cli', 'teste', 'segredo-de-teste');
    assert.equal(await ctx.vault.get('dev.quebragalho.cli', 'teste'), 'segredo-de-teste');
    await ctx.vault.remove('dev.quebragalho.cli', 'teste');
    assert.equal(await ctx.vault.get('dev.quebragalho.cli', 'teste'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
