#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdtemp, writeFile, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';

const harnesses = ['claude', 'codex', 'opencode', 'aider', 'pi', 't3'];
const claudeProfile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'quebragalho', 'claude');

async function gatewayCatalog(rawUrl, key) {
  if (!rawUrl || !key) throw new Error('Configure QUEBRAGALHO_BASE_URL e QUEBRAGALHO_API_KEY.');
  const url = new URL(rawUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('URL base não pode conter credenciais, query ou fragmento.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS (HTTP somente em loopback local).');
  // Accept the API URL people copy from their gateway dashboard.
  const base = url.href.replace(/\/$/, '').replace(/\/v1$/, '');
  const response = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Catálogo indisponível: HTTP ${response.status}.`);
  const catalog = await response.json();
  if (!Array.isArray(catalog.data) || !catalog.data.length || catalog.data.some(x => typeof x?.id !== 'string' || !x.id.trim())) throw new Error('Catálogo inválido ou vazio.');
  return { base, models: [...new Set(catalog.data.map(x => x.id))] };
}

async function ask(question, secret = false) {
  if (!process.stdin.isTTY) throw new Error('Execute setup em um terminal ou forneça QUEBRAGALHO_API_KEY no ambiente.');
  const output = secret ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (secret) process.stdout.write(question);
    return (await prompt.question(secret ? '' : question)).trim();
  } finally { prompt.close(); if (secret) process.stdout.write('\n'); }
}

async function setupClaude() {
  if (process.platform !== 'darwin') throw new Error('Setup permanente usa o Chaves do macOS. Em Linux, use launch.');
  let version;
  try { version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number); }
  catch { throw new Error('Instale Claude Code 2.1.242+ primeiro.'); }
  if (!version || version[0] < 2 || (version[0] === 2 && version[1] === 0) || (version[0] === 2 && version[1] === 1 && version[2] < 242)) throw new Error('Atualize Claude Code para 2.1.242+ para usar /model.');
  const directory = claudeProfile();
  const path = join(directory, 'settings.json');
  const readSettings = () => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const original = await readSettings();
  const settings = JSON.parse(original ?? '{}');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)))) throw new Error('settings.json deve conter um objeto JSON válido.');
  console.log('Configuração única do perfil QG. O Claude oficial não será alterado.');
  const rawUrl = process.env.QUEBRAGALHO_BASE_URL || (await ask('URL do gateway [https://api.quebragalho.dev]: ')) || 'https://api.quebragalho.dev';
  const key = process.env.QUEBRAGALHO_API_KEY || await ask('Chave da API (oculta): ', true);
  if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('Chave vazia ou com caracteres inválidos.');
  const { base, models } = await gatewayCatalog(rawUrl, key);
  // Each profile/gateway/key has its own item, so old settings and backups keep working.
  const identity = createHash('sha256').update(JSON.stringify([resolve(directory), base, key])).digest('hex');
  const account = ['-a', `claude-${identity}`, '-s', 'dev.quebragalho.claude'];
  try {
    // Send the secret over stdin, never in process arguments or settings.json.
    let existing;
    try { existing = execFileSync('/usr/bin/security', ['find-generic-password', ...account, '-w'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* Item not present yet. */ }
    if (existing !== key) execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password ${account.join(' ')} -X ${Buffer.from(key).toString('hex')}\n`, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    const saved = execFileSync('/usr/bin/security', ['find-generic-password', ...account, '-w'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (saved !== key) throw new Error();
  } catch { throw new Error('Não foi possível guardar a chave no Chaves do macOS. Configuração do Claude preservada.'); }
  const model = models.includes(settings.model) ? settings.model : models.includes('gpt-6-luna') ? 'gpt-6-luna' : models[0];
  const env = { ...settings.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' };
  // Background tasks and built-in aliases must also use a model the gateway serves.
  for (const name of ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[name] = model;
  const configured = { ...settings, env,
    apiKeyHelper: `/usr/bin/security find-generic-password ${account.join(' ')} -w`,
    model,
    modelPicker: { options: models.map(model => ({ model, label: `QG · ${model}` })), replaceBuiltInOptions: true } };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, '.quebragalho-'));
  try {
    await writeFile(join(temporary, 'settings.json'), `${JSON.stringify(configured, null, 2)}\n`, { mode: 0o600 });
    if (await readSettings() !== original) throw new Error('settings.json mudou durante o setup. Execute novamente.');
    if (original !== undefined) await writeFile(`${path}.quebragalho-backup-${Date.now()}`, original, { mode: 0o600, flag: 'wx' });
    await rename(join(temporary, 'settings.json'), path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  console.log(`Pronto: ${models.length} modelos configurados. Abra quebragalho claude e escolha em /model. Claude normal continua oficial.\nConfiguração: ${path}\nChave guardada no Chaves do macOS.${original === undefined ? '' : ' Backup das configurações anteriores preservado.'}`);
}

async function configuration(harness, base, model, models) {
  const env = { ...process.env };
  const key = env.QUEBRAGALHO_API_KEY;
  let args = ['--model', model];
  const temporary = await mkdtemp(join(tmpdir(), `quebragalho-${harness}-`));
  Object.assign(env, { HOME: temporary, XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
    XDG_STATE_HOME: join(temporary, 'state') });
  try {
    await Promise.all(['config', 'data', 'cache', 'state'].map(name => mkdir(join(temporary, name))));
    switch (harness) {
      case 'claude':
        env.CLAUDE_CONFIG_DIR = temporary;
        Object.assign(env, { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: model, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' });
        for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
        break;
      case 'codex': {
        env.CODEX_HOME = join(temporary, 'codex');
        await mkdir(env.CODEX_HOME);
        const provider = { name: 'Quebra-galho', base_url: `${base}/v1`, env_key: 'QUEBRAGALHO_API_KEY',
          wire_api: 'responses', requires_openai_auth: false };
        // JSON-quoted strings are also valid TOML basic strings.
        args = ['-c', 'model_provider="quebragalho"', ...Object.entries(provider).flatMap(([name, value]) =>
          ['-c', `model_providers.quebragalho.${name}=${JSON.stringify(value)}`]), '--model', model];
        break;
      }
      case 'opencode':
      case 't3': {
        env.OPENCODE_CONFIG_DIR = join(temporary, 'opencode');
        await mkdir(env.OPENCODE_CONFIG_DIR);
        delete env.OPENCODE_CONFIG;
        const existing = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
        if (Array.isArray(existing.enabled_providers) && !existing.enabled_providers.includes('quebragalho')) existing.enabled_providers.push('quebragalho');
        if (Array.isArray(existing.disabled_providers)) existing.disabled_providers = existing.disabled_providers.filter(id => id !== 'quebragalho');
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...existing, model: `quebragalho/${model}`, small_model: `quebragalho/${model}`,
          provider: { ...existing.provider, quebragalho: { name: 'Quebra-galho', npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `${base}/v1`, apiKey: '{env:QUEBRAGALHO_API_KEY}' },
            models: Object.fromEntries(models.map(id => [id, { name: id }])) } } });
        if (harness === 'opencode') {
          args = ['--model', `quebragalho/${model}`];
          break;
        }
        // T3 runs as a foreground server; the model comes from the private seed, never --model.
        for (const name of Object.keys(env)) if (name.startsWith('T3CODE_')) delete env[name];
        const t3home = join(temporary, 't3');
        env.T3CODE_HOME = t3home;
        // ponytail: T3 support rides on its native OpenCode driver; if T3 gains a first-party gateway provider, seed that instead.
        let binaryPath;
        try { binaryPath = execFileSync('sh', ['-c', 'command -v opencode'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { throw new Error('T3 requer OpenCode instalado no PATH.'); }
        const seed = { providers: { codex: { enabled: false }, claudeAgent: { enabled: false },
          opencode: { enabled: true, binaryPath, customModels: models.map(id => `quebragalho/${id}`) } },
          defaultModelSelection: { instanceId: 'opencode', model: `quebragalho/${model}` },
          textGenerationModelSelection: { instanceId: 'opencode', model: `quebragalho/${model}` },
          sourceControlWriterModelSelection: { instanceId: 'opencode', model: `quebragalho/${model}` } };
        try {
          await mkdir(join(t3home, 'userdata'), { recursive: true });
          await writeFile(join(t3home, 'userdata', 'settings.json'), `${JSON.stringify(seed)}\n`, { mode: 0o600 });
        } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
        args = ['start', '--base-dir', t3home, '--host', '127.0.0.1'];
        break;
      }
      case 'aider':
        await writeFile(join(temporary, 'aider.yml'), '{}\n');
        await writeFile(join(temporary, '.env'), '');
        Object.assign(env, { OPENAI_API_BASE: `${base}/v1`, OPENAI_API_KEY: key });
        args = ['--model', `openai/${model}`, '--config', join(temporary, 'aider.yml'),
          '--env-file', join(temporary, '.env'), '--input-history-file', join(temporary, 'input.history'),
          '--chat-history-file', join(temporary, 'chat.history'), '--llm-history-file', join(temporary, 'llm.history')];
        break;
      case 'pi': {
        env.PI_CODING_AGENT_DIR = join(temporary, 'pi');
        await mkdir(env.PI_CODING_AGENT_DIR);
        const extension = join(temporary, 'provider.mjs');
        try {
          // ponytail: conservative text-only limits; use verified gateway metadata when provided.
          const provider = { baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: '$QUEBRAGALHO_API_KEY',
            models: models.map(id => ({ id, name: id, reasoning: false, input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) };
          await writeFile(extension, `export default function(pi) { pi.registerProvider("quebragalho", ${JSON.stringify(provider)}); }\n`, { mode: 0o600 });
        } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
        args = ['--extension', extension, '--provider', 'quebragalho', '--model', model];
        break;
      }
    }
    return { env, args, temporary };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const helpArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  if (!args.length || helpArgs.includes('--help')) {
    console.log(`Uso: quebragalho setup claude (perfil isolado; depois use quebragalho claude)\nquebragalho launch [${harnesses.join('|')}] [--model ID] [-- argumentos do harness]\nquebragalho list\nPara launch, configure QUEBRAGALHO_BASE_URL e QUEBRAGALHO_API_KEY no ambiente.`);
    return;
  }
  if (args[0] === 'list' && args.length === 1) { console.log(harnesses.join('\n')); return; }
  if (args[0] === 'claude') {
    const directory = claudeProfile();
    try { await readFile(join(directory, 'settings.json')); }
    catch { throw new Error('Configure o perfil QG uma vez: quebragalho setup claude.'); }
    const env = { ...process.env, CLAUDE_CONFIG_DIR: directory };
    // Settings in the QG profile supply credentials and models, without inherited provider overrides.
    for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_')) delete env[name];
    await execute('claude', args.slice(1), env);
    return;
  }
  if (args[0] === 'setup') {
    if (args.length !== 2 || args[1] !== 'claude') throw new Error('Use quebragalho setup claude.');
    await setupClaude();
    return;
  }
  if (args.shift() !== 'launch') throw new Error('Use quebragalho launch.');
  let harness = args[0]?.startsWith('--') ? undefined : args.shift();
  if (!harness && process.stdin.isTTY) {
    harnesses.forEach((name, i) => console.log(`${i + 1}. ${name}`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const choice = (await prompt.question('Escolha um harness: ')).trim();
      harness = /^\d+$/.test(choice) ? harnesses[Number(choice) - 1] : choice;
    } finally { prompt.close(); }
  }
  if (!harnesses.includes(harness)) throw new Error(`Harness inválido. Opções: ${harnesses.join(', ')}.`);
  const separator = args.indexOf('--');
  const forwarded = separator < 0 ? [] : args.splice(separator).slice(1);
  let model;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--model' || !args[1]) throw new Error('Use --model ID e -- antes dos argumentos do Claude.');
    model = args[1];
  }
  const rawUrl = process.env.QUEBRAGALHO_BASE_URL;
  const key = process.env.QUEBRAGALHO_API_KEY;
  const { base, models } = await gatewayCatalog(rawUrl, key);
  if (!model && process.stdin.isTTY && models.length > 1) {
    models.forEach((id, i) => console.log(`${i + 1}. ${id}`));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const choice = (await prompt.question('Escolha um modelo [1]: ')).trim() || '1';
      if (!/^\d+$/.test(choice) || !models[Number(choice) - 1]) throw new Error('Escolha inválida.');
      model = models[Number(choice) - 1];
    } finally { prompt.close(); }
  }
  if (!model && models.length > 1) throw new Error('Sem terminal interativo: informe --model ID.');
  model ??= models[0];
  if (!models.includes(model)) throw new Error('Modelo não encontrado no catálogo.');
  const { env, args: launchArgs, temporary } = await configuration(harness, base, model, models);
  await execute(harness, [...launchArgs, ...forwarded], env, temporary);
}

async function execute(harness, args, env, temporary) {
  // Pass credentials through the environment, never command-line arguments.
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(harness, args, { env, stdio: 'inherit', shell: false });
      const forwardInt = () => child.kill('SIGINT');
      const forwardTerm = () => child.kill('SIGTERM');
      process.on('SIGINT', forwardInt);
      process.on('SIGTERM', forwardTerm);
      const release = () => {
        process.removeListener('SIGINT', forwardInt);
        process.removeListener('SIGTERM', forwardTerm);
      };
      child.on('error', () => { release(); reject(new Error(`${harness} não encontrado ou não pôde iniciar. Instale o harness primeiro.`)); });
      child.on('exit', (code, signal) => { release(); resolve({ code, signal }); });
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
main().catch(error => {
  // Provider bodies, URLs and credentials must not leak through errors.
  const message = error.name === 'Error' ? error.message : 'Confira URL, conexão e configuração JSON.';
  console.error(`quebragalho: ${message}`);
  process.exitCode = 1;
});
