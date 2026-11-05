// Executa o harness repassando sinais e código de saída, e remove o diretório temporário no fim.
import { spawn, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import { spawnPlan, childEnv, envValue } from './proc.mjs';
import { QgError } from './util.mjs';

// Windows: child.kill() mata só o cmd.exe do .cmd; o harness filho seguiria vivo com a chave no ambiente.
export function killTree(child, env, run = spawnSync) {
  const taskkill = win32.join(envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'taskkill.exe');
  try { if (run(taskkill, ['/T', '/F', '/PID', String(child.pid)], { shell: false, stdio: 'ignore', windowsHide: true }).status === 0) return; } catch { /* cai para kill() */ }
  child.kill();
}

function runChild(plan, env, harness, platform) {
  const win = platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { ...plan.options, env, stdio: 'inherit', shell: false });
    const stop = signal => (win && plan.options.windowsVerbatimArguments ? killTree(child, env) : child.kill(signal));
    // Num terminal (e no Windows) o Ctrl+C já chega ao filho pelo grupo/console: reenviar dobraria o sinal.
    const handlers = { SIGINT: () => { if (!win && !process.stdin.isTTY) child.kill('SIGINT'); }, SIGTERM: () => stop('SIGTERM'),
      ...(win ? { SIGBREAK: () => stop() } : { SIGHUP: () => stop('SIGHUP') }) };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const release = () => { for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler); };
    child.on('error', error => { release(); reject(new QgError(`${harness} não pôde iniciar${/^[A-Z0-9_]{1,20}$/.test(error?.code ?? '') ? ` (${error.code})` : ''}.`)); });
    child.on('exit', (code, signal) => { release(); resolve({ code, signal }); });
  });
}

// file: caminho já resolvido do executável.
export async function execute(ctx, harness, file, args, env, temporary) {
  const plan = spawnPlan(file, args, { env, platform: ctx.platform });
  let result;
  try { result = await runChild(plan, childEnv(env, ctx.platform), harness, ctx.platform); }
  finally {
    // Falha ao limpar (arquivo preso no Windows) não pode esconder o código de saída do harness.
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => ctx.err('quebragalho: aviso: não foi possível remover o perfil temporário.'));
  }
  if (result.signal && ctx.platform !== 'win32') process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
