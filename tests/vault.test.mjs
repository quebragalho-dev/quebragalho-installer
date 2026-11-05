// Cofre por sistema, simulado: nenhum teste toca no Chaves, no libsecret nem no DPAPI reais.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createVault, loginAccount, LOGIN_SERVICE, CLAUDE_SERVICE, DPAPI_PROTECT, DPAPI_UNPROTECT } from '../lib/vault.mjs';
import { tempDir, removeDir, KEY } from './helpers.mjs';

const POSIX = { skip: process.platform === 'win32' && 'PATH e permissões POSIX' };
const account = `claude-${'a'.repeat(64)}`;
const base = async (platform, extra = {}) => {
  const dir = await tempDir('qg-vault-');
  return { dir, ctx: { env: { XDG_CONFIG_HOME: join(dir, 'xdg'), APPDATA: join(dir, 'appdata'), PATH: '', ...extra.env }, platform, homedir: () => join(dir, 'home'), exec: () => { throw new Error('sem exec'); }, ...extra.ctx } };
};

test('Given macOS When guarda e lê Then usa security com o segredo só no stdin, no mesmo item de antes', async () => {
  const { dir, ctx } = await base('darwin');
  try {
    const store = new Map();
    const calls = [];
    ctx.exec = (file, args, options = {}) => {
      calls.push({ file, args, options });
      assert.equal(file, '/usr/bin/security');
      assert.ok(!args.join(' ').includes(KEY));
      const [a, s] = [args[args.indexOf('-a') + 1], args[args.indexOf('-s') + 1]];
      if (args[0] === 'find-generic-password') { if (!store.has(`${s}/${a}`)) throw new Error('nf'); return `${store.get(`${s}/${a}`)}\n`; }
      if (args[0] === 'delete-generic-password') { if (!store.delete(`${s}/${a}`)) throw new Error('nf'); return ''; }
      assert.deepEqual(args, ['-i']);
      const match = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]+)\n$/.exec(options.input);
      assert.ok(match, options.input);
      store.set(`${match[2]}/${match[1]}`, Buffer.from(match[3], 'hex').toString());
      return '';
    };
    const vault = createVault(ctx);
    assert.equal(vault.kind, 'keychain');
    assert.deepEqual(await vault.set(CLAUDE_SERVICE, account, KEY), {});
    assert.equal(await vault.get(CLAUDE_SERVICE, account), KEY);
    assert.ok(calls.some(c => c.args[0] === '-i' && c.options.input.includes(`-U -a ${account} -s ${CLAUDE_SERVICE} -X`)));
    const before = calls.length;
    await vault.set(CLAUDE_SERVICE, account, KEY);
    assert.ok(!calls.slice(before).some(c => c.args[0] === '-i' || c.args[0] === 'delete-generic-password'), 'mesmo segredo não regrava');
    const mark = calls.length;
    await vault.set(CLAUDE_SERVICE, account, `${KEY}-novo`);
    assert.equal(await vault.get(CLAUDE_SERVICE, account), `${KEY}-novo`);
    assert.ok(!calls.slice(mark).some(c => c.args[0] === 'delete-generic-password'), 'a chave antiga nunca é apagada antes da nova');
    await vault.remove(CLAUDE_SERVICE, account);
    assert.equal(await vault.get(CLAUDE_SERVICE, account), undefined);
    await vault.remove(CLAUDE_SERVICE, account);
    await assert.rejects(vault.set('servico com espaço', account, KEY), /inválido/);
    await assert.rejects(vault.get(CLAUDE_SERVICE, 'a; rm -rf'), /inválido/);
    ctx.exec = (file, args) => { if (args[0] === '-i') return ''; throw new Error('nf'); };
    await assert.rejects(createVault(ctx).set(CLAUDE_SERVICE, account, KEY), /Chaves do macOS/);
    ctx.exec = (file, args) => { if (args[0] === '-i') throw new Error(KEY); throw new Error('nf'); };
    await assert.rejects(createVault(ctx).set(CLAUDE_SERVICE, account, KEY), error => /guardar a chave no Chaves/.test(error.message) && !error.message.includes(KEY));
    const failure = (status) => Object.assign(new Error('x'), { status });
    ctx.exec = () => { throw failure(44); };
    assert.equal(await createVault(ctx).get(CLAUDE_SERVICE, account), undefined, '44 = item inexistente');
    ctx.exec = () => { throw failure(51); };
    await assert.rejects(createVault(ctx).get(CLAUDE_SERVICE, account), /bloqueado ou acesso negado/);
  } finally { await removeDir(dir); }
});

const withSecretTool = async dir => {
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'secret-tool'), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
};

test('Given Linux com secret-tool When guarda Then libsecret recebe o segredo por stdin', POSIX, async () => {
  const { dir, ctx } = await base('linux');
  try {
    ctx.env.PATH = await withSecretTool(dir);
    const items = new Map();
    ctx.exec = (file, args, options = {}) => {
      assert.ok(file.endsWith('secret-tool'));
      assert.ok(!args.join(' ').includes(KEY));
      const attrs = args.slice(args.indexOf('service')).join('/');
      if (args[0] === 'store') { items.set(attrs, options.input); return ''; }
      if (args[0] === 'lookup') { if (!items.has(attrs)) throw new Error('nf'); return items.get(attrs); }
      if (args[0] === 'clear') { items.delete(attrs); return ''; }
      throw new Error(args[0]);
    };
    const vault = createVault(ctx);
    assert.equal(vault.kind, 'libsecret');
    assert.deepEqual(await vault.set(LOGIN_SERVICE, 'default', KEY), { kind: 'libsecret' });
    assert.equal(await vault.get(LOGIN_SERVICE, 'default'), KEY);
    await assert.rejects(readdir(join(dir, 'xdg', 'quebragalho', 'vault')));
    await vault.remove(LOGIN_SERVICE, 'default');
    assert.equal(await vault.get(LOGIN_SERVICE, 'default'), undefined);
  } finally { await removeDir(dir); }
});

test('Given Linux com secret-tool quebrado When guarda Then cai para arquivo 0600 com aviso explícito', POSIX, async () => {
  const { dir, ctx } = await base('linux');
  try {
    ctx.env.PATH = await withSecretTool(dir);
    ctx.exec = () => { throw new Error('Cannot autolaunch D-Bus'); };
    const vault = createVault(ctx);
    const saved = await vault.set(LOGIN_SERVICE, 'default', KEY);
    assert.equal(saved.kind, 'file');
    assert.match(saved.warning, /0600/);
    assert.ok(saved.warning.includes(join(dir, 'xdg', 'quebragalho', 'vault')));
    assert.equal(await vault.get(LOGIN_SERVICE, 'default'), KEY);
    const directory = join(dir, 'xdg', 'quebragalho', 'vault');
    if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const [file] = await readdir(directory);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    assert.ok(!file.includes('default') && !file.includes(KEY));
    await vault.remove(LOGIN_SERVICE, 'default');
    assert.equal(await vault.get(LOGIN_SERVICE, 'default'), undefined);
  } finally { await removeDir(dir); }
});

test('Given secret-tool que não devolve o que guardou Then não confia e usa arquivo', POSIX, async () => {
  const { dir, ctx } = await base('linux');
  try {
    ctx.env.PATH = await withSecretTool(dir);
    ctx.exec = (file, args) => (args[0] === 'lookup' ? 'outra-coisa' : '');
    assert.equal((await createVault(ctx).set(LOGIN_SERVICE, 'default', KEY)).kind, 'file');
  } finally { await removeDir(dir); }
});

test('Given Linux sem secret-tool (WSL, FreeBSD, contêiner) Then arquivo 0600 e rótulo honesto', async () => {
  for (const platform of ['linux', 'freebsd']) {
    const { dir, ctx } = await base(platform);
    try {
      const vault = createVault(ctx);
      assert.equal(vault.kind, 'file');
      assert.equal((await vault.set(CLAUDE_SERVICE, account, KEY)).kind, 'file');
      assert.equal(await vault.get(CLAUDE_SERVICE, account), KEY);
      await chmod(join(dir, 'xdg'), 0o700);
    } finally { await removeDir(dir); }
  }
});

test('Given QUEBRAGALHO_VAULT=file em qualquer SO Then ignora o cofre nativo', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { dir, ctx } = await base(platform);
    try {
      ctx.env = { QUEBRAGALHO_VAULT: 'file', XDG_CONFIG_HOME: join(dir, 'x'), APPDATA: join(dir, 'ap'), PATH: '' };
      const vault = createVault(ctx);
      assert.equal(vault.kind, 'file');
      assert.match(vault.label, /forçado/);
      await vault.set(LOGIN_SERVICE, 'default', KEY);
      assert.equal(await vault.get(LOGIN_SERVICE, 'default'), KEY);
    } finally { await removeDir(dir); }
  }
});

test('Given Windows When guarda Then DPAPI via PowerShell: segredo no stdin, script fixo, blob em %APPDATA%', async () => {
  const { dir, ctx } = await base('win32');
  try {
    ctx.env.SystemRoot = 'C:\\Windows';
    const scripts = [];
    ctx.exec = (file, args, options = {}) => {
      assert.match(file, /WindowsPowerShell.v1\.0.powershell\.exe$/);
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      assert.ok(!args.join(' ').includes(KEY));
      const script = Buffer.from(args[3], 'base64').toString('utf16le');
      scripts.push(script);
      if (script === DPAPI_PROTECT) return `01000000${Buffer.from(options.input).toString('hex')}\r\n`;
      assert.equal(script, DPAPI_UNPROTECT);
      return Buffer.from(options.input.trim().slice(8), 'hex').toString();
    };
    const vault = createVault(ctx);
    assert.equal(vault.kind, 'dpapi');
    assert.deepEqual(await vault.set(CLAUDE_SERVICE, account, KEY), {});
    assert.equal(await vault.get(CLAUDE_SERVICE, account), KEY);
    const directory = join(dir, 'appdata', 'quebragalho', 'vault');
    const [file] = await readdir(directory);
    assert.ok(file.endsWith('.dpapi'));
    assert.ok(!(await readFile(join(directory, file), 'utf8')).includes(KEY));
    assert.ok(scripts.every(script => !script.includes(KEY)));
    assert.equal(await vault.get(CLAUDE_SERVICE, `claude-${'b'.repeat(64)}`), undefined);
    await vault.remove(CLAUDE_SERVICE, account);
    assert.equal(await vault.get(CLAUDE_SERVICE, account), undefined);
    ctx.exec = () => { throw new Error('boom'); };
    await assert.rejects(createVault(ctx).set(CLAUDE_SERVICE, account, KEY), /DPAPI/);
    ctx.exec = () => '  ';
    await assert.rejects(createVault(ctx).set(CLAUDE_SERVICE, account, KEY), /DPAPI/);
    await writeFile(join(directory, file), 'blob-quebrado');
    ctx.exec = () => { throw new Error('bad blob'); };
    await assert.rejects(createVault(ctx).get(CLAUDE_SERVICE, account), /DPAPI.*login de novo/);
    ctx.exec = (executable, args, options = {}) => (Buffer.from(args[3], 'base64').toString('utf16le') === DPAPI_PROTECT ? 'BLOB' : 'outro-segredo');
    await assert.rejects(createVault(ctx).set(CLAUDE_SERVICE, account, KEY), /DPAPI/);
    await assert.rejects(readFile(join(directory, file)), 'blob que não volta igual é apagado');
  } finally { await removeDir(dir); }
});

test('conta do login depende da URL base: a chave oficial nunca é enviada a outro gateway', () => {
  assert.notEqual(loginAccount('https://api.quebragalho.dev'), loginAccount('https://outro.exemplo'));
  assert.equal(loginAccount('https://a.dev'), loginAccount('https://a.dev'));
  assert.match(loginAccount('https://a.dev'), /^login-[0-9a-f]{32}$/);
});

test('Given PowerShell 7 no PATH Then os scripts do DPAPI não dependem de cmdlets de módulo', () => {
  for (const script of [DPAPI_PROTECT, DPAPI_UNPROTECT]) {
    assert.doesNotMatch(script, /SecureString/);
    assert.match(script, /ProtectedData/);
  }
});
