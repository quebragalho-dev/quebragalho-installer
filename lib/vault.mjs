// Cofre de chaves por sistema. A chave nunca vai em argumento de processo (entra por stdin)
// nem em settings.json. macOS: Chaves. Linux: libsecret (secret-tool) ou arquivo 0600.
// Windows: DPAPI do usuário via PowerShell. Tudo que fala com o sistema passa por ctx.exec.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { QgError } from './util.mjs';
import { resolveCommand, envValue } from './proc.mjs';

export const LOGIN_SERVICE = 'dev.quebragalho.cli';
export const CLAUDE_SERVICE = 'dev.quebragalho.claude';
const SECURITY = '/usr/bin/security';
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const TIMEOUT = 30000;

export const loginAccount = base => `login-${createHash('sha256').update(base).digest('hex').slice(0, 32)}`;

function assertSafe(service, account) {
  if (!SAFE_TOKEN.test(service) || !SAFE_TOKEN.test(account)) throw new QgError('Identificador de cofre inválido.');
}

const digest = (service, account) => createHash('sha256').update(`${service}\0${account}`).digest('hex');

// Arquivo protegido só por permissões (0700 no diretório, 0600 no arquivo), gravação atômica.
function fileStore(dir, name) {
  const path = (service, account) => join(dir, `${digest(service, account)}${name}`);
  return {
    dir,
    async get(service, account) {
      try { return (await readFile(path(service, account), 'utf8')).trim() || undefined; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw new QgError('Não foi possível ler a chave guardada em arquivo.'); }
    },
    async set(service, account, secret) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      const target = path(service, account);
      const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${secret}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
    },
    async remove(service, account) { await rm(path(service, account), { force: true }); },
  };
}

function macVault(ctx) {
  const run = (args, options) => ctx.exec(SECURITY, args, { timeout: TIMEOUT, ...options });
  // Código 44 = item inexistente. Qualquer outra falha do security (cofre bloqueado, acesso negado) aparece ao usuário.
  const find = (service, account) => {
    try { return run(['find-generic-password', '-a', account, '-s', service, '-w']).trim() || undefined; }
    catch (error) { if (error?.status === undefined || error.status === 44) return undefined; throw new QgError('Não foi possível ler o Chaves do macOS (bloqueado ou acesso negado).'); }
  };
  return {
    kind: 'keychain', label: 'Chaves do macOS',
    async get(service, account) { assertSafe(service, account); return find(service, account); },
    async set(service, account, secret) {
      assertSafe(service, account);
      if (find(service, account) !== secret) {
        // Segredo por stdin (hex), nunca nos argumentos. -U atualiza no lugar: a chave antiga nunca é apagada antes da nova.
        try { run(['-i'], { input: `add-generic-password -U -a ${account} -s ${service} -X ${Buffer.from(secret).toString('hex')}\n` }); }
        catch { throw new QgError('Não foi possível guardar a chave no Chaves do macOS.'); }
      }
      if (find(service, account) !== secret) throw new QgError('Não foi possível guardar a chave no Chaves do macOS.');
      return {};
    },
    async remove(service, account) {
      assertSafe(service, account);
      try { run(['delete-generic-password', '-a', account, '-s', service]); } catch { /* item inexistente */ }
    },
  };
}

function linuxVault(ctx, files, secretTool) {
  const run = (args, options) => ctx.exec(secretTool, args, { timeout: TIMEOUT, ...options });
  const attributes = (service, account) => ['service', service, 'account', account];
  const lookup = (service, account) => { try { return run(['lookup', ...attributes(service, account)]).replace(/\r?\n$/, '') || undefined; } catch { return undefined; } };
  const warning = `Sem libsecret/Secret Service funcionando: a chave ficou em arquivo protegido só por permissões (0600) em ${files.dir}. Para mais proteção, instale libsecret-tools e um chaveiro (gnome-keyring ou KWallet).`;
  return {
    kind: secretTool ? 'libsecret' : 'file', label: secretTool ? 'libsecret (secret-tool)' : 'arquivo 0600',
    async get(service, account) {
      assertSafe(service, account);
      // O arquivo só existe se o último set caiu no fallback (o sucesso do libsecret o apaga): é o mais novo.
      return (await files.get(service, account)) ?? (secretTool ? lookup(service, account) : undefined);
    },
    async set(service, account, secret) {
      assertSafe(service, account);
      if (secretTool) {
        try {
          run(['store', '--label', 'Quebra-galho', ...attributes(service, account)], { input: secret });
          if (lookup(service, account) === secret) { await files.remove(service, account); return { kind: 'libsecret' }; }
        } catch { /* cai para o arquivo */ }
        try { run(['clear', ...attributes(service, account)]); } catch { /* sem chaveiro: nada velho para limpar */ }
      }
      await files.set(service, account, secret);
      return { kind: 'file', warning };
    },
    async remove(service, account) {
      assertSafe(service, account);
      if (secretTool) { try { run(['clear', ...attributes(service, account)]); } catch { /* inexistente */ } }
      await files.remove(service, account);
    },
  };
}

// Scripts fixos (sem segredo no texto): o segredo entra e sai por stdin/stdout.
// Direto no .NET: os cmdlets de SecureString falham no powershell.exe quando o PSModulePath vem do PowerShell 7.
const DPAPI_INICIO = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $u=[Text.Encoding]::UTF8; $e=[Security.Cryptography.DataProtectionScope]::CurrentUser; ";
export const DPAPI_PROTECT = `${DPAPI_INICIO}$p=[Console]::In.ReadToEnd().TrimEnd([char]13,[char]10); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($u.GetBytes($p),$null,$e)))`;
export const DPAPI_UNPROTECT = `${DPAPI_INICIO}$t=[Console]::In.ReadToEnd().Trim(); [Console]::Out.Write($u.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t),$null,$e)))`;
const encodePowerShell = script => Buffer.from(script, 'utf16le').toString('base64');

function windowsVault(ctx, files) {
  const powershell = join(envValue(ctx.env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (script, input) => ctx.exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], { input, timeout: TIMEOUT });
  return {
    kind: 'dpapi', label: 'DPAPI do Windows (escopo do usuário)',
    async get(service, account) {
      assertSafe(service, account);
      const blob = await files.get(service, account);
      if (!blob) return undefined;
      try { return run(DPAPI_UNPROTECT, blob).trim() || undefined; }
      catch { throw new QgError('Não foi possível ler a chave guardada (DPAPI). Rode quebragalho login de novo.'); }
    },
    async set(service, account, secret) {
      assertSafe(service, account);
      let blob;
      try { blob = run(DPAPI_PROTECT, secret).trim(); } catch { throw new QgError('Não foi possível proteger a chave com o DPAPI do Windows.'); }
      if (!blob) throw new QgError('Não foi possível proteger a chave com o DPAPI do Windows.');
      await files.set(service, account, blob);
      if (await this.get(service, account) !== secret) { await files.remove(service, account); throw new QgError('Não foi possível proteger a chave com o DPAPI do Windows.'); }
      return {};
    },
    remove: (service, account) => { assertSafe(service, account); return files.remove(service, account); },
  };
}

function dataDir(ctx) {
  const home = ctx.homedir();
  if (ctx.platform === 'win32') return join(envValue(ctx.env, 'APPDATA', 'win32') || join(home, 'AppData', 'Roaming'), 'quebragalho', 'vault');
  return join(ctx.env.XDG_CONFIG_HOME || join(home, '.config'), 'quebragalho', 'vault');
}

// QUEBRAGALHO_VAULT=file força o arquivo 0600 em qualquer sistema (CI, contêineres, testes).
export function createVault(ctx) {
  const forced = ctx.env.QUEBRAGALHO_VAULT === 'file';
  const files = fileStore(dataDir(ctx), ctx.platform === 'win32' && !forced ? '.dpapi' : '.key');
  if (forced) return { ...linuxVault(ctx, files, undefined), label: 'arquivo 0600 (forçado por QUEBRAGALHO_VAULT=file)' };
  if (ctx.platform === 'darwin') return macVault(ctx);
  if (ctx.platform === 'win32') return windowsVault(ctx, files);
  const secretTool = resolveCommand('secret-tool', { env: ctx.env, platform: ctx.platform });
  return linuxVault(ctx, files, secretTool);
}
