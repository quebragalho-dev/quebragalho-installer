// Windows: quoting de cmd.exe, resolução por PATH/PATHEXT e plano de spawn. Roda em qualquer SO
// (modelo do cmd.exe e do runtime C no teste); o teste real com cmd.exe está em windows-real.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { quoteCmdArg, buildCmdLine, spawnPlan, resolveCommand, envValue, missingHarnessError, INSTALL_HINTS, childEnv } from '../lib/proc.mjs';
import { QgError } from '../lib/util.mjs';

// Modelo do runtime C (CommandLineToArgvW pós-2008): barras antes de " dobram; "" dentro de aspas = " literal.
function decodeArgv(line) {
  const args = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i >= line.length) break;
    let current = '';
    let inQuote = false;
    while (i < line.length && (inQuote || line[i] !== ' ')) {
      let backslashes = 0;
      while (line[i] === '\\') { backslashes++; i++; }
      if (line[i] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2) { current += '"'; i++; }
        else if (inQuote && line[i + 1] === '"') { current += '"'; i += 2; }
        else { inQuote = !inQuote; i++; }
      } else { current += '\\'.repeat(backslashes); if (i < line.length && (inQuote || line[i] !== ' ')) current += line[i++]; }
    }
    args.push(current);
  }
  return args;
}

// Modelo do cmd.exe: cada " alterna o estado; metacaracteres fora das aspas e % não neutralizado são injeção.
function cmdInjection(line) {
  let inQuote = false;
  for (const character of line) {
    if (character === '"') inQuote = !inQuote;
    else if (!inQuote && /[&|<>^()%!]/.test(character)) return true;
  }
  return inQuote;
}
const afterCmd = text => text.replaceAll('%%cd:~,%', '%');

const NASTY = ['simples', 'com espaço', 'aspas "duplas"', 'a&b', 'a|b', '100%', '%PATH%', '^caret', 'a<b>c', '(x)', 'fim\\', 'fim\\\\', '\\"', '"', '', 'tab\tx', '!var!', 'a & calc.exe', '"& calc.exe &"', 'ç é ã', '%%', '\\\\"'];

test('Given argumentos hostis When citados para cmd.exe Then viram um único argumento sem injeção', () => {
  for (const arg of NASTY) {
    const quoted = quoteCmdArg(arg);
    assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), arg);
    assert.equal(cmdInjection(quoted), false, `injeção em ${JSON.stringify(arg)} -> ${quoted}`);
    assert.deepEqual(decodeArgv(afterCmd(quoted)), [arg], JSON.stringify(arg));
  }
});

test('citação concreta: espaços, aspas, & | % ^', () => {
  assert.equal(quoteCmdArg('a b'), '"a b"');
  assert.equal(quoteCmdArg('a"b'), '"a""b"');
  assert.equal(quoteCmdArg('a&b|c^d'), '"a&b|c^d"');
  assert.equal(quoteCmdArg('50%'), '"50%%cd:~,%"');
  assert.equal(quoteCmdArg('fim\\'), '"fim\\\\"');
  assert.equal(quoteCmdArg('\\"'), '"\\\\"""');
  assert.equal(quoteCmdArg(''), '""');
  assert.throws(() => quoteCmdArg('a\nb'), QgError);
  assert.throws(() => quoteCmdArg('a\rb'), QgError);
  assert.throws(() => quoteCmdArg('a\0b'), QgError);
  assert.throws(() => quoteCmdArg(42), QgError);
});

test('propriedade: qualquer argumento citado é um argumento só, sem injeção, e volta idêntico', () => {
  const piece = fc.constantFrom('a', 'Z', ' ', '"', '\\', '%', '&', '|', '^', '<', '>', '(', ')', '!', '\t', 'é', '=', ';', '\\\\', '""', '%x%', '$', '`', "'");
  fc.assert(fc.property(fc.array(piece, { maxLength: 24 }).map(parts => parts.join('')), arg => {
    const quoted = quoteCmdArg(arg);
    assert.equal(cmdInjection(quoted), false);
    assert.deepEqual(decodeArgv(afterCmd(quoted)), [arg]);
  }), { numRuns: 1500 });
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 8 }).filter(s => !/[\0\r\n]/.test(s)), { maxLength: 5 }), args => {
    const line = buildCmdLine('C:\\Program Files\\x y\\tool.cmd', args);
    assert.ok(line.startsWith('"') && line.endsWith('"'));
    const inner = line.slice(1, -1);
    assert.equal(cmdInjection(inner), false);
    assert.deepEqual(decodeArgv(afterCmd(inner)), ['C:\\Program Files\\x y\\tool.cmd', ...args]);
  }), { numRuns: 400 });
});

test('Given .cmd/.bat no Windows When spawn Then usa cmd.exe /d /s /c com linha literal', () => {
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const plan = spawnPlan('C:\\n\\claude.cmd', ['-p', 'olá & mundo'], { env, platform: 'win32' });
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(plan.args.slice(0, 5), ['/d', '/e:on', '/v:off', '/s', '/c']);
  assert.equal(plan.args[5], '"' + '"C:\\n\\claude.cmd" "-p" "olá & mundo"' + '"');
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.equal(spawnPlan('C:\\n\\x.BAT', [], { env: {}, platform: 'win32' }).command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(spawnPlan('C:\\n\\x.bat', [], { env: { SystemRoot: 'D:\\Win' }, platform: 'win32' }).command, 'D:\\Win\\System32\\cmd.exe');
});

test('Given .exe ou outro SO When spawn Then direto, sem shell nem citação extra', () => {
  assert.deepEqual(spawnPlan('C:\\n\\claude.exe', ['a b'], { platform: 'win32' }), { command: 'C:\\n\\claude.exe', args: ['a b'], options: {} });
  assert.deepEqual(spawnPlan('/usr/bin/x.cmd', ['a b'], { platform: 'linux' }), { command: '/usr/bin/x.cmd', args: ['a b'], options: {} });
});

test('resolução: PATHEXT no Windows, case-insensitive, nunca o diretório atual', () => {
  const present = new Set(['C:\\bin\\claude.CMD', 'C:\\bin\\tool.exe', 'C:\\x\\run.bat', 'C:\\bin\\nopath']);
  const isFile = path => [...present].some(candidate => candidate.toLowerCase() === path.toLowerCase());
  const env = { Path: 'C:\\empty;C:\\bin', PATHEXT: '.EXE;.CMD' };
  assert.equal(resolveCommand('claude', { env, platform: 'win32', isFile }), 'C:\\bin\\claude.CMD');
  assert.equal(resolveCommand('tool', { env, platform: 'win32', isFile }), 'C:\\bin\\tool.EXE');
  assert.equal(resolveCommand('tool.exe', { env, platform: 'win32', isFile }), 'C:\\bin\\tool.exe');
  assert.equal(resolveCommand('nopath', { env, platform: 'win32', isFile }), undefined);
  assert.equal(resolveCommand('C:\\x\\run.bat', { env: {}, platform: 'win32', isFile }), 'C:\\x\\run.bat');
  assert.equal(resolveCommand('C:\\x\\run', { env: { PATHEXT: '.bat' }, platform: 'win32', isFile }), 'C:\\x\\run.bat');
  assert.equal(resolveCommand('claude', { env: { Path: 'C:\\bin' }, platform: 'win32', isFile }), 'C:\\bin\\claude.CMD', 'sem PATHEXT usa o padrão');
  assert.equal(resolveCommand('ausente', { env, platform: 'win32', isFile }), undefined);
  assert.equal(envValue({ pAtH: 'x' }, 'PATH', 'win32'), 'x');
  assert.equal(envValue({ pAtH: 'x' }, 'PATH', 'linux'), undefined);
});

test('resolução: POSIX usa PATH, ignora entradas vazias e aceita caminho explícito', () => {
  const isFile = path => ['/usr/bin/node', '/opt/x/tool'].includes(path);
  assert.equal(resolveCommand('node', { env: { PATH: ':/nada:/usr/bin' }, platform: 'linux', isFile }), '/usr/bin/node');
  assert.equal(resolveCommand('tool', { env: { PATH: '/usr/bin' }, platform: 'linux', isFile }), undefined);
  assert.equal(resolveCommand('/opt/x/tool', { env: {}, platform: 'linux', isFile }), '/opt/x/tool');
  assert.equal(resolveCommand('node', { env: {}, platform: 'linux', isFile }), undefined);
});

test('mensagem de harness ausente diz o comando oficial de instalação', () => {
  for (const name of Object.keys(INSTALL_HINTS)) assert.ok(missingHarnessError(name).message.includes(INSTALL_HINTS[name]));
  assert.equal(missingHarnessError('outro').message, 'outro não encontrado no PATH.');
});

test('Windows: filhos não procuram comandos no diretório atual; outros SOs ficam como estão', () => {
  const env = { PATH: 'x' };
  assert.deepEqual(childEnv(env, 'win32'), { PATH: 'x', NoDefaultCurrentDirectoryInExePath: '1' });
  assert.equal(childEnv(env, 'linux'), env);
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, undefined);
});
