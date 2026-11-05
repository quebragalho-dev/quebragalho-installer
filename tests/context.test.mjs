// Contexto real (sem simulação): execução de comandos do PATH sem shell, prompt sem terminal e navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext } from '../lib/context.mjs';
import { openBrowser } from '../lib/login.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const POSIX = { skip: process.platform === 'win32' && 'PATH POSIX' };

test('capture roda o comando do PATH sem shell e devolve a saída', () => {
  const ctx = createContext({ env: { PATH: process.env.PATH } });
  assert.match(ctx.capture('node', ['--version']), /^v\d+\.\d+\.\d+/);
  assert.match(ctx.capture('node', ['-p', '"a & b"']), /a & b/);
});

test('capture falha com mensagem clara quando falta ou não responde', () => {
  const ctx = createContext({ env: { PATH: process.env.PATH } });
  assert.throws(() => ctx.capture('comando-que-nao-existe-qg', []), /não encontrado no PATH/);
  assert.throws(() => ctx.capture('node', ['-e', 'process.exit(3)']), /não respondeu/);
});

test('exec padrão passa o segredo por stdin e devolve texto', POSIX, () => {
  const ctx = createContext({ env: process.env });
  assert.equal(ctx.exec('cat', [], { input: 'segredo' }), 'segredo');
  assert.throws(() => ctx.exec('false', []));
});

test('ask sem terminal recusa em vez de travar', async () => {
  const ctx = createContext({ env: {}, isTTY: false });
  await assert.rejects(ctx.ask('Chave: ', true), /terminal interativo/);
});

test('openBrowser abre pelo comando do sistema sem shell e nunca falha o login', POSIX, async () => {
  const dir = await tempDir('qg-browser-');
  try {
    const marker = join(dir, 'aberto.txt');
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`, { mode: 0o755 });
    const ctx = createContext({ env: { PATH: join(dir, 'bin') }, platform: 'linux' });
    assert.equal(openBrowser(ctx, 'https://app.quebragalho.dev/connect/cli?a=1&b=2;touch x'), true);
    for (let i = 0; i < 100; i++) {
      try { await readFile(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(await readFile(marker, 'utf8'), 'https://app.quebragalho.dev/connect/cli?a=1&b=2;touch x');
    assert.equal(openBrowser(createContext({ env: { PATH: '' }, platform: 'linux' }), 'https://app.quebragalho.dev/'), false, 'sem xdg-open: não abre, não falha');
  } finally { await removeDir(dir); }
});
