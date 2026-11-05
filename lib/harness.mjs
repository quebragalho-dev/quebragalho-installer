// Configuração temporária e isolada de cada harness para uma sessão `launch`.
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeModel, piModel } from './catalog.mjs';
import { QgError } from './util.mjs';

export const harnesses = ['claude', 'codex', 'opencode', 'aider', 'pi'];

// HOME, XDG e, no Windows, USERPROFILE/APPDATA/LOCALAPPDATA apontam para o diretório temporário.
export function isolatedEnv(baseEnv, temporary, platform) {
  const env = { ...baseEnv, HOME: temporary, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'),
    XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state') };
  const directories = ['config', 'data', 'cache', 'state'];
  if (platform === 'win32') {
    Object.assign(env, { USERPROFILE: temporary, APPDATA: join(temporary, 'appdata'), LOCALAPPDATA: join(temporary, 'localappdata') });
    directories.push('appdata', 'localappdata');
  }
  return { env, directories: directories.map(name => join(temporary, name)) };
}

async function claudeConfig(env, temporary, { base, key, model }) {
  for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_') || name === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[name];
  env.CLAUDE_CONFIG_DIR = temporary;
  Object.assign(env, { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: model, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model });
  return ['--model', model];
}

async function codexConfig(env, temporary, { base, model }) {
  env.CODEX_HOME = join(temporary, 'codex');
  await mkdir(env.CODEX_HOME);
  const provider = { name: 'Quebra-galho', base_url: `${base}/v1`, env_key: 'QUEBRAGALHO_API_KEY', wire_api: 'responses', requires_openai_auth: false };
  // Strings JSON também são strings básicas TOML válidas.
  return ['-c', 'model_provider="quebragalho"', ...Object.entries(provider).flatMap(([name, value]) =>
    ['-c', `model_providers.quebragalho.${name}=${JSON.stringify(value)}`]), '--model', model];
}

async function opencodeConfig(env, temporary, { base, model, models }) {
  env.OPENCODE_CONFIG_DIR = join(temporary, 'opencode');
  await mkdir(env.OPENCODE_CONFIG_DIR);
  delete env.OPENCODE_CONFIG;
  let existing = {};
  try { existing = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {}; } catch { throw new QgError('OPENCODE_CONFIG_CONTENT não é JSON válido.'); }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...existing, model: `quebragalho/${model}`,
    provider: { ...existing.provider, quebragalho: { name: 'Quebra-galho', npm: '@ai-sdk/openai-compatible',
      options: { baseURL: `${base}/v1`, apiKey: '{env:QUEBRAGALHO_API_KEY}' },
      models: Object.fromEntries(models.map(item => [item.id, opencodeModel(item)])) } } });
  return ['--model', `quebragalho/${model}`];
}

async function aiderConfig(env, temporary, { base, key, model }) {
  await writeFile(join(temporary, 'aider.yml'), '{}\n');
  await writeFile(join(temporary, '.env'), '');
  // AIDER_* e organização/versão da OpenAI herdadas poderiam desviar a chave ou trocar o servidor.
  for (const name of Object.keys(env)) if (name.startsWith('AIDER_') || name === 'OPENAI_ORGANIZATION' || name === 'OPENAI_API_VERSION') delete env[name];
  Object.assign(env, { OPENAI_API_BASE:`${base}/v1`, OPENAI_API_KEY: key });
  return ['--model', `openai/${model}`, '--config', join(temporary, 'aider.yml'), '--env-file', join(temporary, '.env'),
    '--input-history-file', join(temporary, 'input.history'), '--chat-history-file', join(temporary, 'chat.history'), '--llm-history-file', join(temporary, 'llm.history')];
}

async function piConfig(env, temporary, { base, model, models }) {
  env.PI_CODING_AGENT_DIR = join(temporary, 'pi');
  await mkdir(env.PI_CODING_AGENT_DIR);
  const extension = join(temporary, 'provider.mjs');
  const provider = { baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: '$QUEBRAGALHO_API_KEY', models: models.map(piModel) };
  await writeFile(extension, `export default function(pi) { pi.registerProvider("quebragalho", ${JSON.stringify(provider)}); }\n`, { mode: 0o600 });
  return ['--extension', extension, '--provider', 'quebragalho', '--model', model];
}

const builders = { claude: claudeConfig, codex: codexConfig, opencode: opencodeConfig, aider: aiderConfig, pi: piConfig };

// models: linhas normalizadas do catálogo (só chat). Devolve { env, args, temporary }.
export async function configuration(ctx, harness, { base, key, model, models }) {
  const temporary = await mkdtemp(join(tmpdir(), `quebragalho-${harness}-`));
  const { env, directories } = isolatedEnv(ctx.env, temporary, ctx.platform);
  // Só quem lê a chave pela variável a recebe; Claude e Aider usam a variável do próprio provedor.
  if (['codex', 'opencode', 'pi'].includes(harness)) env.QUEBRAGALHO_API_KEY = key; else delete env.QUEBRAGALHO_API_KEY;
  try {
    await Promise.all(directories.map(directory => mkdir(directory)));
    const args = await builders[harness](env, temporary, { base, key, model, models });
    return { env, args, temporary };
  } catch (error) { await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); throw error; }
}
