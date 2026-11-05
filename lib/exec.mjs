// Executa o harness repassando sinais e código de saída, e remove o diretório temporário no fim.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { spawnPlan, childEnv } from './proc.mjs';
import { QgError } from './util.mjs';

function runChild(plan, env, harness, platform) {
  const win = platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { ...plan.options, env, stdio: 'inherit', shell: false });
    // Num terminal (e no Windows) o Ctrl+C já chega ao filho pelo grupo/console: reenviar dobraria o sinal.
    const handlers = { SIGINT: () => { if (!win && !process.stdin.isTTY) child.kill('SIGINT'); }, SIGTERM: () => child.kill('SIGTERM'),
      ...(win ? { SIGBREAK: () => child.kill() } : { SIGHUP: () => child.kill('SIGHUP') }) };
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
