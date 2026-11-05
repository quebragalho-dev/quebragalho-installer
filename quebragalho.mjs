#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext } from './lib/context.mjs';
import { QgError, fail } from './lib/util.mjs';
import { harnesses } from './lib/harness.mjs';
import { launchCommand, claudeProfileCommand } from './lib/launch.mjs';
import { setupClaude } from './lib/claude-setup.mjs';
import { loginCommand, logoutCommand } from './lib/login.mjs';
import { listCommand, balanceCommand, usageCommand, accountCommand, statusCommand, modelsCommand } from './lib/commands.mjs';
import { doctorCommand } from './lib/doctor.mjs';
import { CLAUDE_SERVICE, createVault } from './lib/vault.mjs';

const scriptPath = fileURLToPath(import.meta.url);

export const HELP = `Uso: quebragalho <comando>
  login [--chave] [--sem-navegador]   entra na conta (código no navegador ou chave colada)
  logout                              remove a chave do cofre
  saldo | uso [--periodo 24h|7d|30d] | conta | status [modelo]   (aceitam --json)
  modelos [--busca X] [--visao] [--ferramentas] [--decisao] [--json]
  doctor [--json]                     diagnóstico de Node, cofre, gateway e harnesses
  setup claude                        perfil Claude separado (depois: quebragalho claude)
  launch [${harnesses.join('|')}] [--model ID] [--forcar] [-- argumentos do harness]
  list [--json]
Sem QUEBRAGALHO_API_KEY, os comandos usam a chave do login. QUEBRAGALHO_BASE_URL troca o gateway.`;

// Subcomando interno do apiKeyHelper do Claude: imprime só a chave do perfil.
async function printProfileKey(ctx, args) {
  const [account, mode] = args;
  if (args.length < 1 || args.length > 2 || !/^claude-[0-9a-f]{64}$/.test(account) || (mode !== undefined && mode !== 'file')) fail('Uso interno inválido.');
  // "file": o setup foi feito com QUEBRAGALHO_VAULT=file, que o Claude não herda ao chamar o helper.
  const vault = mode === 'file' ? createVault({ ...ctx, env: { ...ctx.env, QUEBRAGALHO_VAULT: 'file' } }) : ctx.vault;
  const key = await vault.get(CLAUDE_SERVICE, account);
  if (!key) fail('Chave do perfil não encontrada no cofre.');
  process.stdout.write(`${key}\n`);
}

const commands = {
  login: loginCommand, logout: logoutCommand, saldo: balanceCommand, uso: usageCommand, conta: accountCommand,
  status: statusCommand, modelos: modelsCommand, doctor: doctorCommand, list: listCommand,
  claude: claudeProfileCommand, launch: launchCommand, __key: printProfileKey,
};

export async function main(argv, ctx = createContext()) {
  const separator = argv.indexOf('--');
  const head = separator < 0 ? argv : argv.slice(0, separator);
  if (!argv.length || head.includes('--help')) { ctx.out(HELP); return; }
  const [name, ...rest] = argv;
  if (name === 'setup') {
    if (rest.length < 1 || rest[0] !== 'claude') fail('Use quebragalho setup claude.');
    return setupClaude(ctx, rest.slice(1), scriptPath);
  }
  if (!Object.hasOwn(commands, name)) fail(`Comando desconhecido: ${name.slice(0, 40)}. Use quebragalho --help.`);
  return commands[name](ctx, rest);
}

// Só executa quando chamado como programa (os testes importam main).
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(scriptPath); } catch { return false; } };
if (isMain()) {
  main(process.argv.slice(2)).catch(error => {
    // Corpos do provedor, URLs e credenciais não vazam por erros inesperados.
    const code = /^[A-Z0-9_]{1,20}$/.test(error?.code ?? '') ? ` (${error.code})` : '';
    const message = error instanceof QgError ? error.message : `Falha inesperada${code}. Confira URL, conexão e configuração.`;
    console.error(`quebragalho: ${message}`);
    process.exitCode = 1;
  });
}
