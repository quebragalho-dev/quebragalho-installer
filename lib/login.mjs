// quebragalho login / logout: código no navegador (padrão) ou chave colada (--chave).
import { spawn } from 'node:child_process';
import { QgError, parseOptions, isValidKey, printable } from './util.mjs';
import { DEFAULT_BASE, DEFAULT_AUTH_BASE, normalizeBase, fetchCatalog } from './gateway.mjs';
import { requestDeviceCode, pollDeviceToken, normalizeAuthBase, isSafeToOpen, browserCommand } from './device.mjs';
import { LOGIN_SERVICE, loginAccount } from './vault.mjs';
import { resolveCommand } from './proc.mjs';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Tenta abrir o navegador sem nunca falhar o login.
export function openBrowser(ctx, url) {
  try {
    const { command, args } = browserCommand(ctx.platform, url, ctx.env);
    const file = /[\\/]/.test(command) ? command : resolveCommand(command, { env: ctx.env, platform: ctx.platform });
    if (!file) return false;
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function deviceLogin(ctx, base, { openUrl }) {
  const official = base === DEFAULT_BASE;
  if (!official && !ctx.env.QUEBRAGALHO_AUTH_URL) throw new QgError('O login por código só existe no gateway oficial. Com outra URL use quebragalho login --chave.');
  const authBase = normalizeAuthBase(ctx.env.QUEBRAGALHO_AUTH_URL || DEFAULT_AUTH_BASE);
  const auth = await requestDeviceCode(ctx, authBase);
  const link = auth.verificationUriComplete || auth.verificationUri;
  // Texto do servidor vai ao terminal sem caracteres de controle (nada de sequências de escape).
  ctx.out(`Para entrar, abra ${printable(auth.verificationUri || link)}\ne informe o código: ${printable(auth.userCode, 64)}`);
  if (auth.verificationUriComplete) ctx.out(`Link direto: ${printable(auth.verificationUriComplete)}`);
  const safeLink = isSafeToOpen(link, { allowLoopback: LOOPBACK_HOSTS.includes(new URL(authBase).hostname) });
  if (openUrl && ctx.isTTY && safeLink && openBrowser(ctx, safeLink)) ctx.out('Abrindo o navegador...');
  ctx.out('Aguardando a aprovação (Ctrl+C cancela)...');
  return pollDeviceToken(ctx, authBase, auth);
}

// Devolve uma chave validada no gateway: colada (prompt oculto) ou por código.
export async function obtainKey(ctx, base, { paste = false, openUrl = true, allowEmptyForDevice = false } = {}) {
  let key;
  if (paste || allowEmptyForDevice) {
    const question = paste ? 'Cole a chave da API (oculta): ' : 'Enter para entrar por código no navegador, ou cole a chave (oculta): ';
    key = await ctx.ask(question, true);
    if (!key && paste) throw new QgError('Chave vazia.');
  }
  if (!key) key = await deviceLogin(ctx, base, { openUrl });
  if (!isValidKey(key)) throw new QgError('Chave vazia ou com caracteres inválidos.');
  await fetchCatalog(ctx, base, key);
  return key;
}

export async function loginCommand(ctx, args) {
  const { flags } = parseOptions(args, { flags: ['chave', 'sem-navegador'] });
  const base = normalizeBase(ctx.env.QUEBRAGALHO_BASE_URL || DEFAULT_BASE);
  const key = await obtainKey(ctx, base, { paste: flags.chave, openUrl: !flags['sem-navegador'] });
  const saved = await ctx.vault.set(LOGIN_SERVICE, loginAccount(base), key);
  if (saved.warning) ctx.err(`quebragalho: aviso: ${saved.warning}`);
  ctx.out(`Login concluído. Chave guardada em: ${saved.kind === 'file' ? 'arquivo 0600' : ctx.vault.label}.`);
}

export async function logoutCommand(ctx, args) {
  parseOptions(args, {});
  const base = normalizeBase(ctx.env.QUEBRAGALHO_BASE_URL || DEFAULT_BASE);
  const account = loginAccount(base);
  const existing = await ctx.vault.get(LOGIN_SERVICE, account).catch(() => undefined);
  await ctx.vault.remove(LOGIN_SERVICE, account);
  ctx.out(existing ? 'Chave removida do cofre. O perfil Claude do setup guarda a própria chave: rode quebragalho setup claude de novo se quiser trocar.' : 'Nenhuma chave guardada neste cofre.');
}
