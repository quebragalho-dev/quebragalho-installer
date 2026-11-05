// Isolamento de variáveis de ambiente dos harnesses (Claude e Aider) e encerramento da árvore no Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, CATALOG, KEY, tempDir, removeDir } from './helpers.mjs';
import { main } from '../quebragalho.mjs';
import { configuration } from '../lib/harness.mjs';
import { killTree } from '../lib/exec.mjs';

const POSIX = { skip: process.platform === 'win32' && 'harness falso POSIX' };
const ARGS = { base: 'https://api.quebragalho.dev', key: KEY, model: 'model-a', models: [] };

test('Given Aider Then variáveis AIDER_*, organização e versão da API herdadas são removidas', async () => {
  const hostile = { AIDER_OPENAI_API_BASE: 'https://evil.example', AIDER_OPENAI_API_KEY: 'alheia', AIDER_MODEL: 'x', OPENAI_ORGANIZATION: 'org', OPENAI_API_VERSION: 'v', KEEP: 'sim' };
  const { ctx } = makeCtx({ env: { ...hostile, PATH: '' } });
  const { env, args, temporary } = await configuration(ctx, 'aider', ARGS);
  try {
    assert.deepEqual(Object.keys(env).filter(name => name.startsWith('AIDER_')), []);
    assert.deepEqual([env.OPENAI_ORGANIZATION, env.OPENAI_API_VERSION, env.KEEP], [undefined, undefined, 'sim']);
    assert.deepEqual([env.OPENAI_API_BASE, env.OPENAI_API_KEY], ['https://api.quebragalho.dev/v1', KEY]);
    assert.ok(!args.join(' ').includes(KEY), 'chave fora do argv');
  } finally { await removeDir(temporary); }
});

test('Given Claude Then todo ANTHROPIC_* e CLAUDE_CODE_USE_* herdado some e os modelos padrão são o escolhido', async () => {
  const hostile = { ANTHROPIC_FOO: 'x', ANTHROPIC_DEFAULT_OPUS_MODEL: 'outro', ANTHROPIC_SMALL_FAST_MODEL: 'outro', ANTHROPIC_CUSTOM_HEADERS: 'h', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_MANTLE: '1', KEEP: 'sim' };
  const { ctx } = makeCtx({ env: { ...hostile, PATH: '' } });
  const { env, temporary } = await configuration(ctx, 'claude', ARGS);
  try {
    const names = Object.keys(env);
    assert.deepEqual(names.filter(name => name.startsWith('CLAUDE_CODE_USE_')), []);
    assert.deepEqual(names.filter(name => name.startsWith('ANTHROPIC_')).sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']);
    for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) assert.equal(env[name], 'model-a', name);
    assert.deepEqual([env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, env.KEEP], ['https://api.quebragalho.dev', KEY, '', 'sim']);
  } finally { await removeDir(temporary); }
});

test('Given quebragalho claude Then QUEBRAGALHO_API_KEY não chega ao Claude', POSIX, async () => {
  const dir = await tempDir('qg-iso-');
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const capture = join(dir, 'capture.json');
    await writeFile(join(bin, 'claude'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({ qg: process.env.QUEBRAGALHO_API_KEY }));\n`, { mode: 0o755 });
    const profile = join(dir, 'xdg', 'quebragalho', 'claude');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'settings.json'), '{}');
    const { ctx } = makeCtx({ platform: process.platform, env: { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, XDG_CONFIG_HOME: join(dir, 'xdg'), QUEBRAGALHO_API_KEY: KEY } });
    await main(['claude'], ctx);
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).qg, undefined);
  } finally { process.exitCode = 0; await removeDir(dir); }
});

test('Given Windows Then killTree usa taskkill /T /F /PID por caminho absoluto, sem shell', () => {
  const calls = [];
  const child = { pid: 4242, killed: false, kill() { this.killed = true; } };
  killTree(child, { SystemRoot: 'C:\\WINDOWS' }, (file, args, options) => { calls.push({ file, args, options }); return { status: 0 }; });
  assert.deepEqual(calls.map(c => [c.file, c.args, c.options.shell]), [['C:\\WINDOWS\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4242'], false]]);
  assert.equal(child.killed, false);
});

test('Given taskkill que falha ou sem SystemRoot Then usa C:\\Windows e cai para child.kill()', () => {
  const calls = [];
  const child = { pid: 7, killed: false, kill() { this.killed = true; } };
  killTree(child, {}, (file) => { calls.push(file); return { status: 128 }; });
  assert.deepEqual(calls, ['C:\\Windows\\System32\\taskkill.exe']);
  assert.equal(child.killed, true);
  const broken = { pid: 8, killed: false, kill() { this.killed = true; } };
  killTree(broken, {}, () => { throw new Error('sem taskkill'); });
  assert.equal(broken.killed, true);
});
