// Só roda no Windows (CI): launch chamando o .cmd de um harness com argumentos hostis, sem shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { json, makeCtx, router, CATALOG, KEY, tempDir, removeDir } from './helpers.mjs';
import { main } from '../quebragalho.mjs';

const DUMP = `import { writeFileSync } from 'node:fs';
const vars = process.env;
writeFileSync(vars.CAPTURE, JSON.stringify({ args: process.argv.slice(2), profile: vars.USERPROFILE, appdata: vars.APPDATA, local: vars.LOCALAPPDATA }));
process.exit(7);
`;

test('Windows real: launch chama o .cmd do harness com argumentos hostis e perfil isolado', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempDir('qg launch win-');
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'dump.mjs'), DUMP);
    await writeFile(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0dump.mjs" %*\r\n');
    const capture = join(dir, 'capture.json');
    const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === 'path');
    const server = router({ 'GET /v1/models': json(CATALOG), 'GET /v1/balance': json({ available: '50.00' }) });
    const { ctx } = makeCtx({ fetch: server.fetch, platform: 'win32', env: { ...process.env, [pathKey]: `${bin};${process.env[pathKey]}`, CAPTURE: capture, QUEBRAGALHO_API_KEY: KEY } });
    const hostile = ['-p', 'a & b | c', '100%', '%PATH%', '"aspas"', '^x', 'fim\\', '(y)', 'ç é ã'];
    await main(['launch', 'claude', '--model', 'model-a', '--', ...hostile], ctx);
    assert.equal(process.exitCode, 7);
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(captured.args, ['--model', 'model-a', ...hostile]);
    assert.notEqual(captured.profile, process.env.USERPROFILE);
    assert.ok(captured.appdata.startsWith(captured.profile) && captured.local.startsWith(captured.profile));
  } finally { process.exitCode = 0; await removeDir(dir); }
});
