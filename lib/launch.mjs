// quebragalho launch / quebragalho claude: abre um harness com um modelo do gateway.
import { createInterface } from 'node:readline/promises';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { QgError, parseOptions } from './util.mjs';
import { fetchCatalog, fetchBalance, probeEndpoint } from './gateway.mjs';
import { resolveAuth } from './context.mjs';
import { configuration, harnesses } from './harness.mjs';
import { resolveCommand, missingHarnessError } from './proc.mjs';
import { execute } from './exec.mjs';
import { formatBRL } from './format.mjs';
import { claudeProfile } from './claude-setup.mjs';
import { isDecisionModel } from './catalog.mjs';

export const LOW_BALANCE_BRL = 5;
const NO_RESPONSES = 'O gateway ainda não oferece /v1/responses, que o Codex exige (está no roadmap do QG). Use claude, opencode, aider ou pi, ou rode com --forcar para tentar mesmo assim.';

// launch [harness] [--model ID] [--forcar] [-- argumentos do harness]
export function parseLaunchArgs(args) {
  const separator = args.indexOf('--');
  const own = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const { flags, values, positional } = parseOptions(own, { flags: ['forcar'], values: ['model'], max: 1 });
  return { harness: positional[0], model: values.model, force: Boolean(flags.forcar), forwarded };
}

async function choose(ctx, title, options, fallback) {
  options.forEach((name, i) => ctx.out(`${i + 1}. ${name}`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = (await prompt.question(title)).trim() || fallback;
    return /^\d+$/.test(choice) ? options[Number(choice) - 1] : choice;
  } finally { prompt.close(); }
}

async function pickModel(ctx, requested, catalog) {
  const chat = catalog.chat.map(model => model.id);
  if (requested) {
    if (catalog.all.some(model => model.id === requested && isDecisionModel(model))) throw new QgError(`O modelo ${requested} é de decisão (não faz chat) e não funciona em harnesses. Veja quebragalho modelos.`);
    if (!chat.includes(requested)) throw new QgError('Modelo não encontrado no catálogo.');
    return requested;
  }
  if (chat.length > 1 && ctx.isTTY) {
    const picked = await choose(ctx, 'Escolha um modelo [1]: ', chat, '1');
    if (!chat.includes(picked)) throw new QgError('Escolha inválida.');
    return picked;
  }
  if (chat.length > 1) throw new QgError('Sem terminal interativo: informe --model ID.');
  return chat[0];
}

// Aviso de saldo nunca bloqueia nem derruba o launch.
export async function warnLowBalance(ctx, base, key) {
  try {
    const balance = await fetchBalance(ctx, base, key);
    const formatted = formatBRL(balance.available);
    if (formatted === null) return;
    const available = Number(balance.available);
    if (available <= 0) ctx.err(`quebragalho: aviso: saldo zerado (${formatted}). As chamadas podem ser recusadas; recarregue em quebragalho.dev.`);
    else if (available < LOW_BALANCE_BRL) ctx.err(`quebragalho: aviso: saldo baixo (${formatted}).`);
  } catch { /* leitura de saldo falhou: segue sem aviso */ }
}

async function pickHarness(ctx, requested) {
  if (requested) return requested;
  if (!ctx.isTTY) return undefined;
  return choose(ctx, 'Escolha um harness: ', harnesses);
}

export async function launchCommand(ctx, args) {
  const parsed = parseLaunchArgs(args);
  const harness = await pickHarness(ctx, parsed.harness);
  if (!harnesses.includes(harness)) throw new QgError(`Harness inválido. Opções: ${harnesses.join(', ')}.`);
  const file = resolveCommand(harness, { env: ctx.env, platform: ctx.platform });
  if (!file) throw missingHarnessError(harness);
  const { base, key } = await resolveAuth(ctx);
  const catalog = await fetchCatalog(ctx, base, key);
  const model = await pickModel(ctx, parsed.model, catalog);
  if (harness === 'codex' && !parsed.force && await probeEndpoint(ctx, base, key, '/v1/responses') === 404) throw new QgError(NO_RESPONSES);
  await warnLowBalance(ctx, base, key);
  const { env, args: launchArgs, temporary } = await configuration(ctx, harness, { base, key, model, models: catalog.chat });
  await execute(ctx, harness, file, [...launchArgs, ...parsed.forwarded], env, temporary);
}

// quebragalho claude: perfil QG persistente; as credenciais vêm do settings.json do perfil.
export async function claudeProfileCommand(ctx, args) {
  const directory = claudeProfile(ctx);
  try { await access(join(directory, 'settings.json'), constants.R_OK); }
  catch { throw new QgError('Configure o perfil QG uma vez: quebragalho setup claude.'); }
  const file = resolveCommand('claude', { env: ctx.env, platform: ctx.platform });
  if (!file) throw missingHarnessError('claude');
  const env = { ...ctx.env, CLAUDE_CONFIG_DIR: directory };
  for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_') || name === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[name];
  delete env.QUEBRAGALHO_API_KEY;
  await execute(ctx, 'claude', file, args, env);
}
