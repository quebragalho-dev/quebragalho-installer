// quebragalho setup claude: perfil Claude separado, com a chave no cofre do sistema.
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve, win32, posix } from 'node:path';
import { QgError, parseOptions, isValidKey } from './util.mjs';
import { DEFAULT_BASE, normalizeBase, fetchCatalog } from './gateway.mjs';
import { CLAUDE_SERVICE, LOGIN_SERVICE, loginAccount } from './vault.mjs';
import { envValue } from './proc.mjs';
import { obtainKey } from './login.mjs';

// Perfil do QG: nunca o ~/.claude oficial. No Windows fica em %APPDATA%.
export function claudeProfile(ctx) {
  if (ctx.platform === 'win32') return join(envValue(ctx.env, 'APPDATA', 'win32') || join(ctx.homedir(), 'AppData', 'Roaming'), 'quebragalho', 'claude');
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.homedir(), '.config'), 'quebragalho', 'claude');
}

const quoteForShell = (value, platform) => {
  if (platform === 'win32') {
    if (value.includes('"')) throw new QgError('Caminho com aspas não é suportado.');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
};

// Comando que o Claude Code executa para ler a chave: o próprio launcher, sem a chave em argumento.
export function helperCommand(ctx, account, scriptPath) {
  const launcher = ctx.env.QUEBRAGALHO_LAUNCHER;
  // O launcher vem do ambiente e vira comando persistente: só caminho absoluto, sem quebra de linha.
  const absolute = typeof launcher === 'string' && (ctx.platform === 'win32' ? win32 : posix).isAbsolute(launcher) && !/[\r\n\0]/.test(launcher);
  const parts = absolute ? [launcher] : ['node', scriptPath];
  const forced = ctx.env.QUEBRAGALHO_VAULT === 'file' ? ' file' : '';
  return `${parts.map(part => (part === 'node' ? part : quoteForShell(part, ctx.platform))).join(' ')} __key ${account}${forced}`;
}

function assertClaudeVersion(ctx) {
  let version;
  try { version = ctx.capture('claude', ['--version']).match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number); }
  catch { throw new QgError('Instale Claude Code 2.1.242+ primeiro (npm install -g @anthropic-ai/claude-code).'); }
  const [major, minor, patch] = version ?? [0, 0, 0];
  if (major < 2 || (major === 2 && minor === 0) || (major === 2 && minor === 1 && patch < 242)) throw new QgError('Atualize Claude Code para 2.1.242+ para usar /model.');
}

async function storeKey(ctx, account, key) {
  try {
    const saved = await ctx.vault.set(CLAUDE_SERVICE, account, key);
    if (saved.warning) ctx.err(`quebragalho: aviso: ${saved.warning}`);
    return saved.kind === 'file' ? 'arquivo 0600' : ctx.vault.label;
  } catch (error) {
    throw new QgError(error instanceof QgError ? `${error.message} Configuração do Claude preservada.` : 'Não foi possível guardar a chave no cofre. Configuração do Claude preservada.');
  }
}

function buildSettings(settings, ctx, { base, models, account, scriptPath }) {
  const model = models.includes(settings.model) ? settings.model : models.includes('gpt-6-luna') ? 'gpt-6-luna' : models[0];
  const env = { ...settings.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' };
  // Tarefas em segundo plano e aliases embutidos também precisam de um modelo que o gateway serve.
  for (const name of ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[name] = model;
  const apiKeyHelper = ctx.platform === 'darwin' && ctx.vault.kind === 'keychain'
    ? `/usr/bin/security find-generic-password -a ${account} -s ${CLAUDE_SERVICE} -w`
    : helperCommand(ctx, account, scriptPath);
  return { ...settings, env, apiKeyHelper, model,
    modelPicker: { options: models.map(id => ({ model: id, label: `QG · ${id}` })), replaceBuiltInOptions: true } };
}

async function writeSettings(directory, path, original, configured, readSettings) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, '.quebragalho-'));
  try {
    await writeFile(join(temporary, 'settings.json'), `${JSON.stringify(configured, null, 2)}\n`, { mode: 0o600 });
    if (await readSettings() !== original) throw new QgError('settings.json mudou durante o setup. Execute novamente.');
    if (original !== undefined) await writeFile(`${path}.quebragalho-backup-${Date.now()}`, original, { mode: 0o600, flag: 'wx' });
    await rename(join(temporary, 'settings.json'), path);
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

async function readExisting(path) {
  const readSettings = () => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const original = await readSettings();
  let settings;
  try { settings = JSON.parse(original ?? '{}'); } catch { throw new QgError('settings.json deve conter um objeto JSON válido.'); }
  const objectLike = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!objectLike(settings) || (settings.env !== undefined && !objectLike(settings.env))) throw new QgError('settings.json deve conter um objeto JSON válido.');
  return { original, settings, readSettings };
}

export async function setupClaude(ctx, args, scriptPath) {
  const { flags } = parseOptions(args, { flags: ['sem-navegador'] });
  assertClaudeVersion(ctx);
  const directory = claudeProfile(ctx);
  const path = join(directory, 'settings.json');
  const { original, settings, readSettings } = await readExisting(path);
  ctx.out('Configuração única do perfil QG. O Claude oficial não será alterado.');
  const base = normalizeBase(ctx.env.QUEBRAGALHO_BASE_URL || DEFAULT_BASE);
  const key = await setupKey(ctx, base, flags);
  const { chat } = await fetchCatalog(ctx, base, key);
  const models = chat.map(model => model.id);
  // Cada perfil/gateway/chave tem o próprio item: perfis e backups antigos continuam funcionando.
  const account = `claude-${createHash('sha256').update(JSON.stringify([resolve(directory), base, key])).digest('hex')}`;
  const existed = await ctx.vault.get(CLAUDE_SERVICE, account).catch(() => undefined);
  const where = await storeKey(ctx, account, key);
  try { await writeSettings(directory, path, original, buildSettings(settings, ctx, { base, models, account, scriptPath }), readSettings); }
  catch (error) {
    // Sem settings.json apontando para a entrada nova, ela ficaria órfã no cofre.
    if (existed === undefined) await ctx.vault.remove(CLAUDE_SERVICE, account).catch(() => {});
    throw error;
  }
  ctx.out(`Pronto: ${models.length} modelos configurados. Abra quebragalho claude e escolha em /model. Claude normal continua oficial.\nConfiguração: ${path}\nChave guardada em: ${where}.${original === undefined ? '' : ' Backup das configurações anteriores preservado.'}`);
}

// Chave do ambiente, depois a do login no cofre, depois prompt (Enter = login por código).
async function setupKey(ctx, base, flags) {
  if (ctx.env.QUEBRAGALHO_API_KEY) {
    if (!isValidKey(ctx.env.QUEBRAGALHO_API_KEY)) throw new QgError('Chave vazia ou com caracteres inválidos.');
    return ctx.env.QUEBRAGALHO_API_KEY;
  }
  const stored = await ctx.vault.get(LOGIN_SERVICE, loginAccount(base)).catch(() => undefined);
  if (stored && isValidKey(stored)) return stored;
  return obtainKey(ctx, base, { allowEmptyForDevice: true, openUrl: !flags['sem-navegador'] });
}
