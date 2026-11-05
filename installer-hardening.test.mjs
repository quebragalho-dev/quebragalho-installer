// Instalador endurecido: caminhos relativos, origem sem HTTPS, origem local suspeita, troca interrompida.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const POSIX = { skip: process.platform === 'win32' && 'usa sh e launchers POSIX' };

function run(command, args, vars, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...vars }, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function dirs() {
  const dir = await mkdtemp(join(tmpdir(), 'quebragalho-hard-'));
  const home = join(dir, 'home');
  await mkdir(home);
  const vars = { HOME: home, QUEBRAGALHO_BIN_DIR: join(dir, 'bin'), QUEBRAGALHO_NO_PROMPT: '1', XDG_DATA_HOME: '', QUEBRAGALHO_VAULT: 'file', PATH: process.env.PATH };
  return { dir, home, vars, launcher: join(dir, 'bin', 'quebragalho'), app: join(home, '.local', 'share', 'quebragalho') };
}

async function sources() {
  const lib = (await readdir(join(REPO, 'lib'))).filter(name => name.endsWith('.mjs')).map(name => `lib/${name}`);
  return ['quebragalho.mjs', ...lib];
}

async function copyTo(target) {
  await mkdir(target, { recursive: true });
  for (const file of await sources()) { await mkdir(dirname(join(target, file)), { recursive: true }); await cp(join(REPO, file), join(target, file)); }
}

test('install.sh exige caminhos absolutos e HTTPS na origem', POSIX, async () => {
  const { dir, vars } = await dirs();
  try {
    const script = await readFile(join(REPO, 'install.sh'), 'utf8');
    const relativeBin = await run('sh', ['install.sh'], { ...vars, QUEBRAGALHO_BIN_DIR: 'bin-relativo' }, { cwd: REPO });
    assert.equal(relativeBin.code, 1);
    assert.match(relativeBin.output, /QUEBRAGALHO_BIN_DIR deve ser um caminho absoluto/);
    const relativeHome = await run('sh', ['install.sh'], { ...vars, QUEBRAGALHO_HOME: 'home-relativo' }, { cwd: REPO });
    assert.equal(relativeHome.code, 1);
    assert.match(relativeHome.output, /QUEBRAGALHO_HOME deve ser um caminho absoluto/);
    const http = await run('sh', [], { ...vars, QUEBRAGALHO_RAW_URL: 'http://example.com/raw' }, { input: script, cwd: dir });
    assert.equal(http.code, 1);
    assert.match(http.output, /deve usar HTTPS/);
    await assert.rejects(stat(join(dir, 'bin', 'quebragalho')));
    assert.deepEqual(await readdir(join(vars.HOME, '.local', 'share')).catch(() => []), [], 'nada sobrou');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Given curl | sh num diretório com arquivos locais e um arquivo chamado sh Then baixa em vez de copiar do diretório', POSIX, async () => {
  const { dir, vars } = await dirs();
  try {
    const cwd = join(dir, 'suspeito');
    await copyTo(cwd);
    await writeFile(join(cwd, 'sh'), 'não sou o instalador\n');
    const raw = join(dir, 'raw');
    await copyTo(raw);
    await rm(join(raw, 'lib', 'vault.mjs'));
    const script = await readFile(join(REPO, 'install.sh'), 'utf8');
    const result = await run('sh', [], { ...vars, QUEBRAGALHO_RAW_URL: pathToFileURL(raw).href }, { input: script, cwd });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Falha ao baixar lib\/vault\.mjs/, 'usou a origem remota, não o diretório atual');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Given troca interrompida entre os dois mv Then a instalação anterior volta inteira', POSIX, async () => {
  const { dir, vars, launcher, app } = await dirs();
  try {
    assert.equal((await run('sh', ['install.sh'], vars, { cwd: REPO })).code, 0);
    await writeFile(join(app, 'lib', 'marcador-da-versao-antiga.mjs'), '// versão antiga\n');
    const shim = join(dir, 'shim');
    await mkdir(shim);
    await writeFile(join(shim, 'mv'), '#!/bin/sh\ncase "$1" in *.quebragalho-stage.*) echo "mv simulado falhou" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    const failed = await run('sh', ['install.sh'], { ...vars, PATH: `${shim}:${process.env.PATH}` }, { cwd: REPO });
    assert.notEqual(failed.code, 0);
    assert.equal(await readFile(join(app, 'lib', 'marcador-da-versao-antiga.mjs'), 'utf8'), '// versão antiga\n', 'a instalação anterior voltou');
    assert.deepEqual((await readdir(dirname(app))).filter(name => name.startsWith('.quebragalho')), [], 'sem estágio nem backup');
    assert.equal((await run(launcher, ['list'], vars)).code, 0, 'o launcher antigo continua funcionando');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('install.sh não trata como nosso um arquivo que só cita o launcher antigo', POSIX, async () => {
  const { dir, vars, launcher } = await dirs();
  try {
    await mkdir(join(dir, 'bin'));
    const alien = "#!/bin/sh\n# usa: const harnesses = ['claude', 'codex', 'opencode', 'aider', 'pi'];\necho meu\n";
    await writeFile(launcher, alien, { mode: 0o755 });
    const result = await run('sh', ['install.sh'], vars, { cwd: REPO });
    assert.equal(result.code, 1);
    assert.equal(await readFile(launcher, 'utf8'), alien);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('install.ps1: launcher .cmd desliga a busca no diretório atual; PATH, links e rollback tratados', async () => {
  const script = await readFile(join(REPO, 'install.ps1'), 'utf8');
  for (const trecho of ['NoDefaultCurrentDirectoryInExePath=1', 'ReparsePoint', 'DoNotExpandEnvironmentNames', 'ExpandEnvironmentVariables', 'Read-Host $question } catch', 'Move-Item -LiteralPath $old -Destination $appDir', "StartsWith('https://')"]) {
    assert.ok(script.includes(trecho), trecho);
  }
  assert.ok(!/^\s*exit\b/m.test(script), 'sem exit: fecharia o terminal de quem usa irm | iex');
});

test('install.ps1: bloco & { } isola funções, QUEBRAGALHO_BIN_DIR relativo é recusado e falha de PATH não interrompe', async () => {
  const script = await readFile(join(REPO, 'install.ps1'), 'utf8');
  const code = script.split('\n').filter(line => !line.startsWith('#')).join('\n');
  assert.match(code.trimStart(), /^& \{\nfunction Msg/, 'tudo dentro de & { }');
  assert.match(code.trimEnd(), /Install-Quebragalho\n\}$/, 'o bloco fecha depois da chamada');
  assert.ok(script.includes("QUEBRAGALHO_BIN_DIR -notmatch") || script.includes('QUEBRAGALHO_BIN_DIR -and'), 'valida caminho absoluto');
  assert.ok(script.includes('QUEBRAGALHO_BIN_DIR deve ser um caminho absoluto'));
  const path = script.slice(script.indexOf('function Add-ToUserPath'), script.indexOf('function Show-NextSteps'));
  assert.ok(/catch \{[\s\S]*Adicione \{1\} ao PATH manualmente[\s\S]*return[\s\S]*\}/.test(path), 'falha no registro vira instrução manual');
  assert.ok(path.indexOf('OpenSubKey') > path.indexOf('try {'), 'abrir o registro está dentro do try');
});
