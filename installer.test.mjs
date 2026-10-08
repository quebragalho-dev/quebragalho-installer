import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, readlink, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}

test('installer and installed launch preserve arguments, environment and failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quebragalho-test-'));
  try {
    // Mock only transport: execute the actual installed launcher and child binaries.
    const preload = join(dir, 'transport.mjs');
    await writeFile(preload, `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://gateway.example/v1/models');
        assert.equal(options.headers.Authorization, 'Bearer test-secret');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        if (process.env.MOCK_NETWORK_ERROR) throw new TypeError('test-secret');
        return new Response(process.env.MOCK_BODY || JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}),
          {status: Number(process.env.MOCK_STATUS || 200)});
      };
    `);
    const officialFiles = ['.claude/settings.json', '.codex/config.toml', '.config/opencode/opencode.json', '.aider.conf.yml', '.pi/agent/models.json', '.t3/userdata/settings.json'];
    for (const file of officialFiles) {
      const path = join(dir, 'home', file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'official-provider-and-model');
    }
    const capture = join(dir, 'capture.json');
    const fake = `#!/usr/bin/env node\nconst fs = require('node:fs'); const args=process.argv.slice(2); const extension=args.includes('--extension') ? args[args.indexOf('--extension')+1] : undefined; fs.writeFileSync(process.env.CAPTURE, JSON.stringify({args,configDir:process.env.CLAUDE_CONFIG_DIR,home:process.env.HOME,codexHome:process.env.CODEX_HOME,opencodeDir:process.env.OPENCODE_CONFIG_DIR,opencodeFile:process.env.OPENCODE_CONFIG,piDir:process.env.PI_CODING_AGENT_DIR,xdgConfig:process.env.XDG_CONFIG_HOME,xdgData:process.env.XDG_DATA_HOME,base:process.env.ANTHROPIC_BASE_URL,token:process.env.ANTHROPIC_AUTH_TOKEN,api:process.env.ANTHROPIC_API_KEY,discovery:process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,bedrock:process.env.CLAUDE_CODE_USE_BEDROCK,openaiBase:process.env.OPENAI_API_BASE,openaiKey:process.env.OPENAI_API_KEY,opencode:process.env.OPENCODE_CONFIG_CONTENT,extension:extension ? fs.readFileSync(extension,'utf8') : undefined}));if(process.env.MOCK_SIGNAL) process.kill(process.pid,'SIGTERM'); else if(process.env.MOCK_WAIT) setInterval(()=>{},1000); else process.exit(7);\n`;
    for (const name of ['claude', 'codex', 'opencode', 'aider', 'pi']) await writeFile(join(dir, name), fake, { mode: 0o755 });
    const fakeT3 = `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);const at=args.indexOf('--base-dir');const baseDir=at<0?undefined:args[at+1];let settings;try{settings=fs.readFileSync(baseDir+'/userdata/settings.json','utf8')}catch{}fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,home:process.env.HOME,xdgConfig:process.env.XDG_CONFIG_HOME,xdgData:process.env.XDG_DATA_HOME,opencodeDir:process.env.OPENCODE_CONFIG_DIR,opencodeFile:process.env.OPENCODE_CONFIG,opencode:process.env.OPENCODE_CONFIG_CONTENT,t3Home:process.env.T3CODE_HOME,t3Port:process.env.T3CODE_PORT,t3Host:process.env.T3CODE_HOST,baseDir,settings}));if(process.env.MOCK_SIGNAL)process.kill(process.pid,'SIGTERM');else if(process.env.MOCK_WAIT)setInterval(()=>{},1000);else process.exit(7);\n`;
    await writeFile(join(dir, 't3'), fakeT3, { mode: 0o755 });
    const env = { HOME: join(dir, 'home'), QUEBRAGALHO_BIN_DIR: dir, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture,
      NODE_OPTIONS: `--import=${preload}`, QUEBRAGALHO_BASE_URL: 'https://gateway.example', QUEBRAGALHO_API_KEY: 'test-secret', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_HOME: '/official/codex', OPENCODE_CONFIG_DIR: '/official/opencode', OPENCODE_CONFIG: '/official/opencode.json', PI_CODING_AGENT_DIR: '/official/pi',
      ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '', OPENAI_API_BASE: '', OPENAI_API_KEY: '', OPENCODE_CONFIG_CONTENT: '' };
    assert.equal((await run('sh', ['install.sh'], env)).code, 0);
    const installed = join(dir, 'quebragalho');
    const original = await readFile(installed, 'utf8');
    assert.equal((await run('sh', ['install.sh'], env)).code, 1);
    assert.equal(await readFile(installed, 'utf8'), original);
    await rm(installed);
    const missing = join(dir, 'missing');
    await symlink(missing, installed);
    assert.equal((await run('sh', ['install.sh'], env)).code, 1);
    assert.equal(await readlink(installed), missing);
    await rm(installed);
    assert.equal((await run('sh', ['install.sh'], env)).code, 0);
    assert.equal((await run(installed, ['--help'], env)).code, 0);
    assert.deepEqual((await run(installed, ['list'], env)).output.trim().split('\n'), ['claude', 'codex', 'opencode', 'aider', 'pi', 't3']);
    const result = await run(installed, ['launch', 'claude', '--model', 'model-b', '--', '-p', 'hello world; $(echo nope)'], env);
    assert.equal(result.code, 7);
    const claude = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(claude.args, ['--model', 'model-b', '-p', 'hello world; $(echo nope)']);
    assert.equal(claude.base, env.QUEBRAGALHO_BASE_URL);
    assert.equal(claude.token, 'test-secret');
    assert.equal(claude.api, '');
    assert.equal(claude.discovery, '1');
    assert.equal(claude.bedrock, undefined);
    assert.notEqual(claude.configDir, join(dir, 'home', '.claude'));
    await assert.rejects(stat(claude.configDir), { code: 'ENOENT' });
    assert.equal((await run(installed, ['launch', 'claude', '--model', 'model-b', '--', '--help'], env)).code, 7);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')).args, ['--model', 'model-b', '--help']);
    for (const harness of ['codex', 'opencode', 'aider', 'pi', 't3']) {
      const launchEnv = harness === 'opencode' || harness === 't3' ? { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { official: { name: 'Official provider' } }, theme: 'existing' }) } : env;
      if (harness === 't3') Object.assign(launchEnv, { T3CODE_PORT: '9999', T3CODE_HOST: '0.0.0.0', T3CODE_HOME: '/official/t3' });
      const outcome = await run(installed, ['launch', harness, '--model', 'model-b', '--', '--help'], launchEnv);
      assert.equal(outcome.code, 7, outcome.output);
      const captured = JSON.parse(await readFile(capture, 'utf8'));
      assert.equal(captured.args.at(-1), '--help');
      assert.notEqual(captured.home, env.HOME);
      assert.ok(captured.xdgConfig.startsWith(captured.home + '/'));
      assert.ok(captured.xdgData.startsWith(captured.home + '/'));
      await assert.rejects(stat(captured.home), { code: 'ENOENT' });
      assert.ok(!captured.args.join(' ').includes('test-secret'));
      if (harness === 'codex') {
        assert.ok(captured.codexHome.startsWith(captured.home + '/'));
        assert.ok(captured.args.includes('model_provider="quebragalho"'));
        assert.ok(captured.args.includes('model_providers.quebragalho.wire_api="responses"'));
        assert.ok(captured.args.includes('model_providers.quebragalho.env_key="QUEBRAGALHO_API_KEY"'));
        assert.ok(captured.args.includes('model_providers.quebragalho.base_url="https://gateway.example/v1"'));
      }
      if (harness === 'opencode') {
        assert.ok(captured.opencodeDir.startsWith(captured.home + '/'));
        assert.equal(captured.opencodeFile, undefined);
        const config = JSON.parse(captured.opencode);
        assert.equal(config.model, 'quebragalho/model-b');
        assert.deepEqual(config.provider.official, { name: 'Official provider' });
        assert.equal(config.theme, 'existing');
        assert.deepEqual(Object.keys(config.provider.quebragalho.models), ['model-a', 'model-b']);
        assert.equal(config.provider.quebragalho.options.apiKey, '{env:QUEBRAGALHO_API_KEY}');
      }
      if (harness === 'aider') {
        assert.equal(captured.openaiBase, 'https://gateway.example/v1');
        assert.equal(captured.openaiKey, 'test-secret');
        assert.deepEqual(captured.args.slice(0, 2), ['--model', 'openai/model-b']);
        for (const flag of ['--config', '--env-file', '--input-history-file', '--chat-history-file', '--llm-history-file']) assert.ok(captured.args[captured.args.indexOf(flag) + 1].startsWith(captured.home + '/'));
      }
      if (harness === 'pi') {
        assert.ok(captured.piDir.startsWith(captured.home + '/'));
        let provider;
        const extension = await import(`data:text/javascript,${encodeURIComponent(captured.extension)}`);
        extension.default({ registerProvider: (name, value) => { assert.equal(name, 'quebragalho'); provider = value; } });
        assert.equal(provider.apiKey, '$QUEBRAGALHO_API_KEY');
        assert.equal(provider.api, 'openai-completions');
        assert.equal(provider.models.length, 2);
        await assert.rejects(readFile(captured.args[1]), { code: 'ENOENT' });
      }
      if (harness === 't3') {
        assert.deepEqual(captured.args.slice(0, 4), ['start', '--base-dir', captured.baseDir, '--host']);
        assert.equal(captured.args[4], '127.0.0.1');
        assert.equal(captured.args.at(-1), '--help');
        assert.ok(!captured.args.includes('--model'));
        assert.ok(!captured.args.includes('--port'));
        assert.ok(captured.baseDir.startsWith(captured.home + '/'));
        assert.equal(captured.t3Home, captured.baseDir);
        assert.equal(captured.t3Port, undefined);
        assert.equal(captured.t3Host, undefined);
        assert.ok(captured.opencodeDir.startsWith(captured.home + '/'));
        assert.equal(captured.opencodeFile, undefined);
        const t3config = JSON.parse(captured.opencode);
        assert.deepEqual(t3config.provider.official, { name: 'Official provider' });
        assert.deepEqual(Object.keys(t3config.provider.quebragalho.models), ['model-a', 'model-b']);
        assert.equal(t3config.provider.quebragalho.options.baseURL, 'https://gateway.example/v1');
        assert.equal(t3config.provider.quebragalho.options.apiKey, '{env:QUEBRAGALHO_API_KEY}');
        const seed = JSON.parse(captured.settings);
        assert.equal(seed.providers.opencode.enabled, true);
        assert.equal(seed.providers.opencode.binaryPath, join(dir, 'opencode'));
        assert.deepEqual(seed.providers.opencode.customModels, ['quebragalho/model-a', 'quebragalho/model-b']);
        assert.equal(seed.providers.codex.enabled, false);
        assert.equal(seed.providers.claudeAgent.enabled, false);
        for (const selection of [seed.defaultModelSelection, seed.textGenerationModelSelection, seed.sourceControlWriterModelSelection]) {
          assert.equal(selection.instanceId, 'opencode');
          assert.equal(selection.model, 'quebragalho/model-b');
        }
        assert.ok(!captured.settings.includes('test-secret'));
        await assert.rejects(stat(captured.baseDir), { code: 'ENOENT' });
      }
    }
    const signaled = await run(installed, ['launch', 'pi', '--model', 'model-b'], { ...env, MOCK_SIGNAL: '1' });
    assert.equal(signaled.signal, 'SIGTERM');
    const interrupted = JSON.parse(await readFile(capture, 'utf8'));
    await assert.rejects(readFile(interrupted.args[1]), { code: 'ENOENT' });
    await rm(capture);
    const running = spawn(installed, ['launch', 'pi', '--model', 'model-b'], {
      env: { ...process.env, ...env, MOCK_WAIT: '1' }, stdio: 'ignore',
    });
    try {
      const closed = new Promise(resolve => running.on('close', (code, signal) => resolve({ code, signal })));
      let active;
      for (let i = 0; i < 100; i++) {
        try { active = JSON.parse(await readFile(capture, 'utf8')); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      assert.ok(active, 'Pi child started');
      running.kill('SIGTERM');
      assert.equal((await closed).signal, 'SIGTERM');
      await assert.rejects(readFile(active.args[1]), { code: 'ENOENT' });
    } finally { running.kill('SIGKILL'); }
    await rm(join(dir, 'pi'));
    assert.equal((await run(installed, ['launch', 'pi', '--model', 'model-b'], env)).code, 1);
    const t3signaled = await run(installed, ['launch', 't3', '--model', 'model-b'], { ...env, MOCK_SIGNAL: '1' });
    assert.equal(t3signaled.signal, 'SIGTERM');
    await assert.rejects(stat(JSON.parse(await readFile(capture, 'utf8')).baseDir), { code: 'ENOENT' });
    await rm(join(dir, 't3'));
    assert.equal((await run(installed, ['launch', 't3', '--model', 'model-b'], env)).code, 1);
    for (const [args, overrides] of [
      [['launch', 'claude'], {}],
      [['launch', 'claude', '--model', 'missing'], {}],
      [['launch', 'claude'], { QUEBRAGALHO_API_KEY: '' }],
      [['launch', 'claude'], { QUEBRAGALHO_BASE_URL: 'http://example.com' }],
      [['launch', 'bogus'], {}],
      [['launch', 'claude'], { QUEBRAGALHO_BASE_URL: 'https://user:pass@gateway.example' }],
      [['launch', 'claude', '--model', 'model-a'], { MOCK_NETWORK_ERROR: '1' }],
      [['launch', 'claude', '--model', 'model-a'], { MOCK_BODY: '{"data":[]}' }],
      [['launch', 'claude', '--model', 'model-a'], { MOCK_BODY: 'invalid JSON' }],
    ]) {
      const failure = await run(installed, args, { ...env, ...overrides });
      assert.equal(failure.code, 1);
      assert.ok(!failure.output.includes('test-secret'));
    }
    assert.equal((await run(installed, ['launch', 'claude', '--model', 'model-a'], { ...env, MOCK_STATUS: '401' })).code, 1);
    for (const file of officialFiles) assert.equal(await readFile(join(dir, 'home', file), 'utf8'), 'official-provider-and-model');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Claude setup uses an isolated profile and leaves official models and providers intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quebragalho-setup-test-'));
  try {
    const profile = join(dir, 'quebragalho', 'claude');
    await mkdir(profile, { recursive: true });
    const settings = join(profile, 'settings.json');
    const official = join(dir, 'official');
    await mkdir(official);
    const officialSettings = join(official, 'settings.json');
    await writeFile(officialSettings, '{"model":"sonnet","env":{"KEEP":"official"}}');
    const original = JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ['Read(private)'] },
      env: { KEEP: 'yes', ANTHROPIC_AUTH_TOKEN: 'old-token', CLAUDE_CODE_USE_BEDROCK: '1' } });
    await writeFile(settings, original);
    const preload = join(dir, 'setup-transport.mjs');
    await writeFile(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      let stored = false;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      childProcess.execFileSync = (command, args, options) => {
        if (command === 'claude') return process.env.OLD_CLAUDE ? '2.1.100' : '2.1.286';
        assert.equal(command, '/usr/bin/security');
        assert.ok(!args.join(' ').includes('test-secret'));
        if (process.env.KEYCHAIN_FAIL) throw new Error('test-secret');
        if (args[0] === '-i') {
          assert.ok(options.input.includes(Buffer.from('test-secret').toString('hex')));
          assert.ok(!options.input.includes(' -U '));
          stored = true;
          writeFileSync(process.env.KEYCHAIN_CAPTURE, options.input.split(' -X ')[0]);
          if (process.env.CONCURRENT_SETTINGS) writeFileSync(process.env.SETTINGS_PATH, '{"concurrent":true}');
          return '';
        }
        if (!stored) throw new Error('Item not found');
        return 'test-secret\\n';
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://gateway.example/v1/models');
        assert.equal(options.headers.Authorization, 'Bearer test-secret');
        return new Response(JSON.stringify({data:[{id:'model-a'},{id:'gpt-6-luna'}]}),
          {status: process.env.BAD_CATALOG ? 401 : 200});
      };
    `);
    const env = { CLAUDE_CONFIG_DIR: official, XDG_CONFIG_HOME: dir, QUEBRAGALHO_BASE_URL: 'https://gateway.example',
      QUEBRAGALHO_API_KEY: 'test-secret', NODE_OPTIONS: `--import=${preload}`, KEYCHAIN_CAPTURE: join(dir, 'keychain-capture'), SETTINGS_PATH: settings };
    const setup = () => run('node', ['quebragalho.mjs', 'setup', 'claude'], env);
    const result = await setup();
    assert.equal(result.code, 0, result.output);
    assert.ok(!result.output.includes('test-secret'));
    const configured = JSON.parse(await readFile(settings, 'utf8'));
    assert.deepEqual(configured.hooks, { Stop: [] });
    assert.deepEqual(configured.permissions, { deny: ['Read(private)'] });
    assert.equal(configured.env.KEEP, 'yes');
    assert.equal(configured.env.ANTHROPIC_BASE_URL, 'https://gateway.example');
    assert.equal(configured.env.ANTHROPIC_API_KEY, '');
    assert.equal(configured.env.ANTHROPIC_AUTH_TOKEN, '');
    assert.equal(configured.env.CLAUDE_CODE_USE_BEDROCK, '0');
    assert.equal(configured.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-6-luna');
    assert.equal(configured.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-6-luna');
    assert.equal(configured.model, 'gpt-6-luna');
    assert.deepEqual(configured.modelPicker.options.map(row => row.model), ['model-a', 'gpt-6-luna']);
    assert.equal(configured.modelPicker.replaceBuiltInOptions, true);
    assert.match(configured.apiKeyHelper, /^\/usr\/bin\/security find-generic-password /);
    assert.ok(!(await readFile(settings, 'utf8')).includes('test-secret'));
    assert.equal((await stat(settings)).mode & 0o777, 0o600);
    const backups = (await readdir(profile)).filter(name => name.startsWith('settings.json.quebragalho-backup-'));
    assert.equal(await readFile(join(profile, backups[0]), 'utf8'), original);
    const firstAccount = await readFile(env.KEYCHAIN_CAPTURE, 'utf8');
    const fakeClaude = join(dir, 'claude');
    const shortcutCapture = join(dir, 'shortcut-capture.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.SHORTCUT_CAPTURE, JSON.stringify({configDir:process.env.CLAUDE_CONFIG_DIR,api:process.env.ANTHROPIC_API_KEY,args:process.argv.slice(2)}));
`, { mode: 0o755 });
    const shortcut = await run('node', ['quebragalho.mjs', 'claude', '-p', 'test'], {
      ...env, NODE_OPTIONS: '', PATH: `${dir}:${process.env.PATH}`, SHORTCUT_CAPTURE: shortcutCapture, ANTHROPIC_API_KEY: 'official-token',
    });
    assert.equal(shortcut.code, 0, shortcut.output);
    assert.deepEqual(JSON.parse(await readFile(shortcutCapture, 'utf8')), { configDir: profile, args: ['-p', 'test'] });
    assert.equal(await readFile(officialSettings, 'utf8'), '{"model":"sonnet","env":{"KEEP":"official"}}');
    configured.model = 'model-a';
    await writeFile(settings, JSON.stringify(configured));
    assert.equal((await setup()).code, 0);
    assert.equal(JSON.parse(await readFile(settings, 'utf8')).model, 'model-a');
    assert.equal(await readFile(env.KEYCHAIN_CAPTURE, 'utf8'), firstAccount);
    for (const overrides of [{ KEYCHAIN_FAIL: '1' }, { BAD_CATALOG: '1' }, { OLD_CLAUDE: '1' }]) {
      const before = await readFile(settings, 'utf8');
      const failure = await run('node', ['quebragalho.mjs', 'setup', 'claude'], { ...env, ...overrides });
      assert.equal(failure.code, 1);
      assert.ok(!failure.output.includes('test-secret'));
      assert.equal(await readFile(settings, 'utf8'), before);
    }
    const concurrent = await run('node', ['quebragalho.mjs', 'setup', 'claude'], { ...env, CONCURRENT_SETTINGS: '1' });
    assert.equal(concurrent.code, 1);
    assert.equal(await readFile(settings, 'utf8'), '{"concurrent":true}');
    const otherDir = join(dir, 'other-profile');
    const other = await run('node', ['quebragalho.mjs', 'setup', 'claude'], { ...env, XDG_CONFIG_HOME: otherDir });
    assert.equal(other.code, 0, other.output);
    assert.notEqual(JSON.parse(await readFile(join(otherDir, 'quebragalho', 'claude', 'settings.json'), 'utf8')).apiKeyHelper, configured.apiKeyHelper);
    assert.notEqual(await readFile(env.KEYCHAIN_CAPTURE, 'utf8'), firstAccount);
    assert.equal(await readFile(officialSettings, 'utf8'), '{"model":"sonnet","env":{"KEEP":"official"}}');
    await writeFile(settings, 'invalid JSON');
    assert.equal((await setup()).code, 1);
    assert.equal(await readFile(settings, 'utf8'), 'invalid JSON');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
