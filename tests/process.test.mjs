// execute() (sinais, código de saída, limpeza), contexto padrão, navegador do login e entrada do programa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, stat, symlink, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { json, makeCtx, tempDir, removeDir, KEY, CATALOG } from './helpers.mjs';
import { execute } from '../lib/exec.mjs';
import { createContext, resolveAuth } from '../lib/context.mjs';
import { loginCommand } from '../lib/login.mjs';
import { main, HELP } from '../quebragalho.mjs';
import { LOGIN_SERVICE, loginAccount } from '../lib/vault.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = { skip: process.platform === 'win32' && 'processos POSIX' };
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

// Filho que avisa que iniciou (por arquivo), prende os sinais e sai com um código por sinal.
async function fakeHarness(dir, body) {
  const file = join(dir, 'filho.mjs');
  await writeFile(file, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\n${body}\n`, { mode: 0o755 });
  return file;
}

const listeners = () => Object.fromEntries(SIGNALS.map(signal => [signal, process.listenerCount(signal)]));

async function started(marker) {
  for (let i = 0; i < 200; i++) { try { await stat(marker); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.fail('o filho não iniciou');
}

test('execute: devolve o código do filho e solta os manipuladores de sinal', POSIX, async () => {
  const dir = await tempDir('qg-exec-');
  try {
    const file = await fakeHarness(dir, 'process.exit(Number(process.argv[2]));');
    const before = listeners();
    for (const code of [0, 7, 42]) {
      process.exitCode = undefined;
      await execute({ platform: process.platform, err() {} }, 'falso', file, [String(code)], { ...process.env });
      assert.equal(process.exitCode, code);
      assert.deepEqual(listeners(), before);
    }
  } finally { process.exitCode = 0; await removeDir(dir); }
});

test('execute: remove o perfil temporário; falha ao remover vira aviso e não troca o código de saída', POSIX, async () => {
  const dir = await tempDir('qg-exec-');
  try {
    const file = await fakeHarness(dir, 'process.exit(5);');
    const temporary = join(dir, 'perfil');
    await mkdir(temporary);
    await writeFile(join(temporary, 'x'), 'x');
    await execute({ platform: process.platform, err() {} }, 'falso', file, [], { ...process.env }, temporary);
    assert.equal(process.exitCode, 5);
    await assert.rejects(stat(temporary), { code: 'ENOENT' });
    if (process.getuid?.() === 0) return;
    const parent = join(dir, 'protegido');
    await mkdir(join(parent, 'perfil'), { recursive: true });
    await chmod(parent, 0o500);
    const warnings = [];
    try { await execute({ platform: process.platform, err: text => warnings.push(text) }, 'falso', file, [], { ...process.env }, join(parent, 'perfil')); }
    finally { await chmod(parent, 0o700); }
    assert.equal(process.exitCode, 5);
    assert.deepEqual(warnings, ['quebragalho: aviso: não foi possível remover o perfil temporário.']);
  } finally { process.exitCode = 0; await removeDir(dir); }
});

test('execute: harness que não inicia vira erro claro com o código técnico', POSIX, async () => {
  const dir = await tempDir('qg-exec-');
  try {
    await assert.rejects(execute({ platform: process.platform, err() {} }, 'falso', join(dir, 'nao-existe'), [], { ...process.env }), error => error.message === 'falso não pôde iniciar (ENOENT).');
    const before = listeners();
    assert.deepEqual(before, listeners());
  } finally { await removeDir(dir); }
});

async function signalRun(platform, signal) {
  const dir = await tempDir('qg-exec-');
  try {
    const marker = join(dir, 'iniciou');
    const file = await fakeHarness(dir, `
      writeFileSync(${JSON.stringify(marker)}, 'ok');
      const codes = { SIGINT: 11, SIGTERM: 12, SIGHUP: 13 };
      for (const [name, code] of Object.entries(codes)) process.on(name, () => process.exit(code));
      setTimeout(() => process.exit(99), 4000);
    `);
    const run = execute({ platform, err() {} }, 'falso', file, [], { ...process.env });
    await started(marker);
    process.exitCode = undefined;
    process.emit(signal);
    await run;
    return process.exitCode;
  } finally { process.exitCode = 0; await removeDir(dir); }
}

test('execute (POSIX): SIGINT sem terminal, SIGTERM e SIGHUP chegam ao filho', POSIX, async () => {
  const before = listeners();
  if (!process.stdin.isTTY) assert.equal(await signalRun(process.platform, 'SIGINT'), 11);
  assert.equal(await signalRun(process.platform, 'SIGTERM'), 12);
  assert.equal(await signalRun(process.platform, 'SIGHUP'), 13);
  assert.deepEqual(listeners(), before);
});

test('execute (modo Windows): SIGINT não é reenviado; SIGBREAK encerra o filho e o código sai por exitCode', POSIX, async () => {
  const dir = await tempDir('qg-exec-');
  try {
    const marker = join(dir, 'iniciou');
    const file = await fakeHarness(dir, `writeFileSync(${JSON.stringify(marker)}, 'ok'); setTimeout(() => process.exit(21), 600);`);
    const run = execute({ platform: 'win32', err() {} }, 'falso', file, [], { ...process.env });
    await started(marker);
    process.exitCode = undefined;
    process.emit('SIGINT');
    await run;
    assert.equal(process.exitCode, 21, 'o filho seguiu vivo depois do SIGINT');
    const second = join(dir, 'segundo');
    const long = await fakeHarness(dir, `writeFileSync(${JSON.stringify(second)}, 'ok'); setTimeout(() => process.exit(0), 5000);`);
    const killed = execute({ platform: 'win32', err() {} }, 'falso', long, [], { ...process.env });
    await started(second);
    process.emit('SIGBREAK');
    await killed;
    assert.equal(process.exitCode, 1, 'morto por sinal no Windows: sem código, vira 1');
  } finally { process.exitCode = 0; await removeDir(dir); }
});

test('execute re-emite o sinal que matou o filho (processo à parte)', POSIX, async () => {
  const dir = await tempDir('qg-exec-');
  try {
    const file = await fakeHarness(dir, "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 2000);");
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [join(ROOT, 'tests', 'exec-child.mjs'), file], { stdio: 'ignore' });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
  } finally { await removeDir(dir); }
});

test('contexto padrão: fetch, relógio, espera, saída e cofre injetado', async () => {
  const ctx = createContext({ env: {} });
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const logged = [];
  try {
    globalThis.fetch = async (...args) => ({ args });
    console.log = text => logged.push(['out', text]);
    console.error = text => logged.push(['err', text]);
    assert.deepEqual((await ctx.fetch('u', { a: 1 })).args, ['u', { a: 1 }]);
    ctx.out('saida');
    ctx.err('erro');
  } finally { globalThis.fetch = realFetch; console.log = realLog; console.error = realError; }
  assert.deepEqual(logged, [['out', 'saida'], ['err', 'erro']]);
  assert.ok(Math.abs(ctx.now() - Date.now()) < 1000);
  const started = Date.now();
  await ctx.wait(30);
  assert.ok(Date.now() - started >= 25);
  assert.equal(ctx.platform, process.platform);
  const own = { kind: 'meu' };
  assert.equal(createContext({ env: {}, vault: own }).vault, own);
  assert.ok(createContext({ env: {} }).vault.kind);
});

test('exec padrão: stdin só quando há segredo; sem entrada o filho não lê', POSIX, () => {
  const ctx = createContext({ env: process.env });
  assert.equal(ctx.exec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' }), 'abc');
  assert.equal(ctx.exec(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write(d)); process.stdin.on("end", () => process.stdout.write("fim"))']), 'fim');
  assert.throws(() => ctx.exec(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 50 }));
});

test('resolveAuth informa a origem da chave', async () => {
  const fromEnv = makeCtx({ env: { QUEBRAGALHO_API_KEY: KEY } });
  assert.equal((await resolveAuth(fromEnv.ctx)).source, 'env');
  const fromVault = makeCtx({ env: {} });
  await fromVault.ctx.vault.set(LOGIN_SERVICE, loginAccount('https://api.quebragalho.dev'), 'k');
  assert.equal((await resolveAuth(fromVault.ctx)).source, 'cofre');
});

// ---- navegador do login
const CODE = { device_code: 'd', user_code: 'U-1', verification_uri: 'https://app.quebragalho.dev/connect/cli', verification_uri_complete: 'https://app.quebragalho.dev/connect/cli?c=U-1', interval: 1, expires_in: 600 };

async function loginRun(dir, { code = CODE, isTTY = true, args = [], env = {}, expectOpen = false } = {}) {
  const marker = join(dir, 'aberto.txt');
  await rm(marker, { force: true });
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`, { mode: 0o755 });
  const answers = [json({ access_token: KEY }), json(CATALOG)];
  const fetch = async url => (new URL(url).pathname.endsWith('/code') ? json(code) : answers.shift());
  const { ctx, lines } = makeCtx({ fetch, isTTY, platform: 'linux', env: { PATH: join(dir, 'bin'), ...env } });
  await loginCommand(ctx, args);
  let opened = null;
  for (let i = 0; i < (expectOpen ? 150 : 15) && opened === null; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    try { opened = (await readFile(marker, 'utf8')) || null; } catch { /* ainda não abriu */ }
  }
  return { opened, text: lines.out.join('\n') };
}

test('login abre o navegador só quando é seguro, interativo e permitido', POSIX, async () => {
  const dir = await tempDir('qg-nav-');
  try {
    const official = await loginRun(dir, { expectOpen: true });
    assert.equal(official.opened, CODE.verification_uri_complete);
    assert.match(official.text, /Abrindo o navegador/);
    assert.equal((await loginRun(dir, { isTTY: false })).opened, null, 'sem terminal');
    assert.equal((await loginRun(dir, { args: ['--sem-navegador'] })).opened, null, '--sem-navegador');
    const evil = { ...CODE, verification_uri: 'https://evil.example/', verification_uri_complete: 'https://evil.example/?c=1' };
    assert.equal((await loginRun(dir, { code: evil })).opened, null, 'domínio de fora');
    const local = { ...CODE, verification_uri: 'http://localhost:3000/c', verification_uri_complete: 'http://localhost:3000/c?x=1' };
    assert.equal((await loginRun(dir, { code: local })).opened, null, 'loopback com login oficial');
    const both = await loginRun(dir, { expectOpen: true, code: local, env: { QUEBRAGALHO_BASE_URL: 'http://localhost:9999', QUEBRAGALHO_AUTH_URL: 'http://127.0.0.1:3000/api' } });
    assert.equal(both.opened, 'http://localhost:3000/c?x=1', 'loopback quando o login também é local');
    const v6 = await loginRun(dir, { expectOpen: true, code: local, env: { QUEBRAGALHO_BASE_URL: 'http://localhost:9999', QUEBRAGALHO_AUTH_URL: 'http://[::1]:3000/api' } });
    assert.equal(v6.opened, 'http://localhost:3000/c?x=1');
    const named = await loginRun(dir, { expectOpen: true, code: local, env: { QUEBRAGALHO_BASE_URL: 'http://localhost:9999', QUEBRAGALHO_AUTH_URL: 'http://localhost:3000/api' } });
    assert.equal(named.opened, 'http://localhost:3000/c?x=1');
  } finally { await removeDir(dir); }
});

test('login mostra o que o servidor deu: só URL simples, só link direto, ou os dois', POSIX, async () => {
  const dir = await tempDir('qg-nav-');
  try {
    const only = await loginRun(dir, { isTTY: false, code: { ...CODE, verification_uri_complete: undefined } });
    assert.match(only.text, /abra https:\/\/app\.quebragalho\.dev\/connect\/cli\ne informe o código: U-1/);
    assert.ok(!only.text.includes('Link direto'));
    const complete = await loginRun(dir, { isTTY: false, code: { ...CODE, verification_uri: undefined } });
    assert.match(complete.text, /abra https:\/\/app\.quebragalho\.dev\/connect\/cli\?c=U-1\n/);
    assert.match(complete.text, /Link direto: https:\/\/app\.quebragalho\.dev\/connect\/cli\?c=U-1/);
    const both = await loginRun(dir, { isTTY: false });
    assert.match(both.text, /abra https:\/\/app\.quebragalho\.dev\/connect\/cli\ne informe o código: U-1\nLink direto: .*\?c=U-1\nAguardando a aprovação \(Ctrl\+C cancela\)\.\.\./);
  } finally { await removeDir(dir); }
});

// ---- o programa como executável
const runProgram = (args, vars = {}, script = join(ROOT, 'quebragalho.mjs')) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, QUEBRAGALHO_VAULT: 'file', ...vars }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', data => out += data);
  child.stderr.on('data', data => err += data);
  child.on('close', code => resolve({ code, out, err }));
});

test('programa: ajuda, comando desconhecido, erro inesperado e chamada por link simbólico', POSIX, async () => {
  const help = await runProgram(['--help']);
  assert.deepEqual([help.code, help.out.trim()], [0, HELP]);
  assert.match(HELP, /launch \[claude\|codex\|opencode\|aider\|pi\] \[--model ID\] \[--forcar\]/);
  const unknown = await runProgram(['nada']);
  assert.deepEqual([unknown.code, unknown.out, unknown.err], [1, '', 'quebragalho: Comando desconhecido: nada. Use quebragalho --help.\n']);
  assert.equal((await runProgram(['--', '--help'])).code, 1, 'depois de -- não é ajuda');
  const dir = await tempDir('qg-prog-');
  try {
    const link = join(dir, 'link.mjs');
    await symlink(join(ROOT, 'quebragalho.mjs'), link);
    const viaLink = await runProgram(['list'], {}, link);
    assert.deepEqual([viaLink.code, viaLink.out.trim().split('\n')], [0, ['claude', 'codex', 'opencode', 'aider', 'pi']]);
    const preload = join(dir, 'boom.mjs');
    await writeFile(preload, "import fs from 'node:fs'; const original = fs.promises.access; fs.promises.access = async () => { throw Object.assign(new Error('segredo interno'), { code: 'EBOOM' }); }; void original;\n");
    const profile = await runProgram(['claude'], { NODE_OPTIONS: `--import=${preload}`, XDG_CONFIG_HOME: dir });
    assert.equal(profile.code, 1);
    const fail = await runProgram(['__key', `claude-${'a'.repeat(64)}`], { XDG_CONFIG_HOME: join(dir, 'xdg') });
    assert.match(fail.err, /Chave do perfil não encontrada/);
  } finally { await removeDir(dir); }
});

test('main: __key e setup validam os argumentos', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(main(['__key', `claude-${'a'.repeat(64)}`, 'file', 'x'], ctx), /interno/);
  await assert.rejects(main(['__key', `CLAUDE-${'a'.repeat(64)}`], ctx), /interno/);
  await assert.rejects(main(['__key', `claude-${'a'.repeat(64)}x`], ctx), /interno/);
  await assert.rejects(main(['__key', `xclaude-${'a'.repeat(64)}`], ctx), /interno/);
  await assert.rejects(main(['setup', 'claude'], { ...ctx, capture: () => { throw new Error('x'); }, env: {}, homedir: () => '/nao/existe' }), /Instale Claude Code/);
  await assert.rejects(main(['--', '--help'], ctx), /desconhecido/);
});

test('ask: prompt oculto não ecoa a resposta; o comum mostra a pergunta', async () => {
  const { PassThrough } = await import('node:stream');
  for (const secret of [true, false]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', data => shown += data);
    const ctx = createContext({ env: {}, isTTY: true, input, output });
    const answer = ctx.ask('Chave: ', secret);
    setTimeout(() => input.write('  minha-resposta  \n'), 20);
    assert.equal(await answer, 'minha-resposta');
    assert.ok(shown.includes('Chave: '));
    if (secret) { assert.ok(!shown.includes('minha-resposta'), 'sem eco'); assert.ok(shown.endsWith('\n')); }
  }
});
