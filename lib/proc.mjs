// Resolução de executáveis e criação de processos, inclusive .cmd/.bat no Windows (Node recusa
// spawn direto desses arquivos com shell:false). Sem shell: o cmd.exe só recebe linha já citada.
import { statSync, accessSync, constants } from 'node:fs';
import { extname, win32, posix } from 'node:path';
import { QgError } from './util.mjs';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// No Windows as variáveis são case-insensitive, mas uma cópia do process.env perde isso.
export function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const defaultIsFile = (path, platform) => {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
};

// Procura o comando no PATH (e PATHEXT no Windows). Nunca olha o diretório atual.
export function resolveCommand(name, { env = process.env, platform = process.platform, isFile = defaultIsFile } = {}) {
  const win = platform === 'win32';
  const path = win ? win32 : posix;
  const extensions = win ? (envValue(env, 'PATHEXT', platform) || DEFAULT_PATHEXT).split(';').filter(Boolean) : [''];
  const hasExtension = win && extensions.some(extension => name.toLowerCase().endsWith(extension.toLowerCase()));
  const variants = base => (win ? (hasExtension ? [base] : extensions.map(extension => base + extension)) : [base]);
  const hasSeparator = win ? /[\\/:]/.test(name) : name.includes('/');
  const directories = hasSeparator ? [undefined] : (envValue(env, 'PATH', platform) ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const directory of directories) {
    const found = variants(directory === undefined ? name : path.join(directory, name)).find(candidate => isFile(candidate, platform));
    if (found) return found;
  }
  return undefined;
}

// Citação para cmd.exe /c de um .cmd/.bat (mesma regra da biblioteca padrão do Rust após BatBadBut):
// sempre entre aspas, " dobrado, barras invertidas dobradas antes de aspas, % neutralizado.
export function quoteCmdArg(arg) {
  if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) throw new QgError('Argumento com quebra de linha ou NUL não pode ser encaminhado a um .cmd/.bat no Windows.');
  let out = '"';
  let backslashes = 0;
  for (const character of arg) {
    if (character === '\\') backslashes++;
    else {
      if (character === '"') out += '\\'.repeat(backslashes) + '"';
      backslashes = 0;
    }
    out += character === '%' ? '%%cd:~,%' : character;
  }
  return `${out}${'\\'.repeat(backslashes)}"`;
}

export const buildCmdLine = (file, args) => `"${[file, ...args].map(quoteCmdArg).join(' ')}"`;

// Plano de spawn: { command, args, options } para child_process.spawn com shell:false.
export function spawnPlan(file, args, { env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extname(file).toLowerCase())) {
    const comspec = envValue(env, 'ComSpec', platform) || win32.join(envValue(env, 'SystemRoot', platform) || 'C:\\Windows', 'System32', 'cmd.exe');
    // /e:on /v:off: expansão de extensões previsível e sem expansão atrasada (!VAR!) nos argumentos.
    return { command: comspec, args: ['/d', '/e:on', '/v:off', '/s', '/c', buildCmdLine(file, args)], options: { windowsVerbatimArguments: true } };
  }
  return { command: file, args, options: {} };
}

// No Windows o cmd.exe procura comandos no diretório atual antes do PATH; isto desliga essa busca nos filhos.
export const childEnv = (env, platform) => (platform === 'win32' ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env);

export const INSTALL_HINTS = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g opencode-ai',
  aider: 'python -m pip install aider-install && aider-install',
  pi: 'npm install -g @earendil-works/pi-coding-agent',
};

export function missingHarnessError(harness) {
  const hint = INSTALL_HINTS[harness];
  return new QgError(`${harness} não encontrado no PATH.${hint ? ` Instale com: ${hint}` : ''}`);
}
