// CI (Windows): guarda e lê um valor fictício no cofre DPAPI real, chamado a partir de um passo pwsh.
// Cobre o powershell.exe 5.1 sendo chamado por um PowerShell 7 (PSModulePath herdado).
import assert from 'node:assert/strict';
import { createContext } from '../../lib/context.mjs';
import { LOGIN_SERVICE } from '../../lib/vault.mjs';

const ctx = createContext();
assert.equal(ctx.vault.kind, 'dpapi', 'o cofre deve ser o DPAPI, não o arquivo forçado');
const account = `ci-${process.pid}`;
const secret = 'valor-ficticio-de-teste-0123456789';
try {
  await ctx.vault.set(LOGIN_SERVICE, account, secret);
  assert.equal(await ctx.vault.get(LOGIN_SERVICE, account), secret);
  console.log('DPAPI: gravou e leu o valor de teste');
} finally { await ctx.vault.remove(LOGIN_SERVICE, account); }
assert.equal(await ctx.vault.get(LOGIN_SERVICE, account), undefined);
