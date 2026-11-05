// Comandos de leitura da conta: saldo, uso, conta, status, modelos. Todos aceitam --json.
import { QgError, parseOptions, asJson } from './util.mjs';
import { fetchBalance, fetchKeyInfo, fetchStatus, fetchUsage, fetchCatalog } from './gateway.mjs';
import { resolveAuth } from './context.mjs';
import { filterModels } from './catalog.mjs';
import { formatBRL, formatCount, formatPrice, formatTokens, table } from './format.mjs';
import { harnesses } from './harness.mjs';

const PERIODS = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 };
const STATUS_LABELS = { operational: 'operacional', degraded: 'degradado', outage: 'fora do ar', no_data: 'sem dados', maintenance: 'em manutenção' };
const dash = value => (value === null || value === undefined ? '-' : value);
const emit = (ctx, json, data, render) => ctx.out(json ? asJson(data) : render(data));

export async function listCommand(ctx, args) {
  const { flags } = parseOptions(args, { flags: ['json'] });
  emit(ctx, flags.json, harnesses, list => list.join('\n'));
}

export async function balanceCommand(ctx, args) {
  const { flags } = parseOptions(args, { flags: ['json'] });
  const { base, key } = await resolveAuth(ctx);
  const balance = await fetchBalance(ctx, base, key);
  const view = { currency: balance.currency, available: balance.available, recharged: balance.default, bonus: balance.bonus };
  emit(ctx, flags.json, view, data => [`Disponível: ${formatBRL(data.available) ?? dash(data.available)}`,
    `Recarregado: ${formatBRL(data.recharged) ?? dash(data.recharged)}`, `Bônus: ${formatBRL(data.bonus) ?? dash(data.bonus)}`].join('\n'));
}

export async function usageCommand(ctx, args) {
  const { flags, values } = parseOptions(args, { flags: ['json'], values: ['periodo'] });
  const period = values.periodo ?? '24h';
  if (!PERIODS[period]) throw new QgError('Período inválido. Use 24h, 7d ou 30d.');
  const to = new Date(ctx.now());
  const from = new Date(to.getTime() - PERIODS[period] * 3600000);
  const iso = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { base, key } = await resolveAuth(ctx);
  const usage = await fetchUsage(ctx, base, key, { from: iso(from), to: iso(to) });
  const view = { period, from: usage.from, to: usage.to, requests: usage.requests, inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens, cachedInputTokens: usage.cached_input_tokens };
  emit(ctx, flags.json, view, data => [`Uso da chave atual, últimas ${period}`, `Requisições: ${formatCount(data.requests)}`,
    `Entrada: ${formatCount(data.inputTokens)} tokens (cache: ${formatCount(data.cachedInputTokens)})`,
    `Saída: ${formatCount(data.outputTokens)} tokens`, `Total: ${formatCount(data.inputTokens + data.outputTokens)} tokens`].join('\n'));
}

// Só dados da chave e do plano: nenhum dado pessoal do dono da conta.
export async function accountCommand(ctx, args) {
  const { flags } = parseOptions(args, { flags: ['json'] });
  const { base, key } = await resolveAuth(ctx);
  const info = await fetchKeyInfo(ctx, base, key);
  const view = { name: info.name, keyPrefix: info.key_prefix, createdAt: info.created_at, plan: info.plan ?? null,
    allowedModels: Array.isArray(info.allowed_models) ? info.allowed_models : null };
  emit(ctx, flags.json, view, data => [`Chave: ${dash(data.name)} (${dash(data.keyPrefix)}...)`,
    `Plano: ${dash(data.plan?.code)} (${dash(data.plan?.type)})`, `Criada em: ${dash(data.createdAt)}`,
    `Modelos permitidos: ${data.allowedModels ? data.allowedModels.join(', ') || 'nenhum' : 'todos'}`].join('\n'));
}

const label = status => STATUS_LABELS[status] ?? dash(status);

function renderStatus(data) {
  const counts = data.overall?.counts ?? {};
  const lines = [`Geral: ${label(data.overall?.status)} (${Object.entries(counts).map(([name, n]) => `${n} ${label(name)}`).join(', ')})`];
  for (const notice of [data.platform_notice, ...(data.notices ?? [])].filter(Boolean)) lines.push(`Aviso: ${typeof notice === 'string' ? notice : notice.message ?? notice.title ?? JSON.stringify(notice)}`);
  if (data.data.length) lines.push(table(['MODELO', 'ESTADO', 'SUCESSO 30m'], data.data.map(row => [row.display_name ?? row.id, label(row.status), dash(row.windows?.['30m']?.success_rate)])));
  return lines.join('\n');
}

export async function statusCommand(ctx, args) {
  const { flags, positional } = parseOptions(args, { flags: ['json'], max: 1 });
  const { base, key } = await resolveAuth(ctx);
  const status = await fetchStatus(ctx, base, key);
  const rows = Array.isArray(status.data) ? status.data : [];
  const needle = positional[0]?.toLowerCase();
  const selected = needle ? rows.filter(row => row.id?.toLowerCase() === needle || row.display_name?.toLowerCase().includes(needle)) : rows;
  if (needle && !selected.length) throw new QgError('Modelo não encontrado no status.');
  emit(ctx, flags.json, { ...status, data: selected }, renderStatus);
}

const prices = (pricing, symbol) => (pricing?.input && pricing?.output ? `${formatPrice(pricing.input, symbol)} / ${formatPrice(pricing.output, symbol)}` : '-');
const capabilityFlags = ({ tools, vision, reasoning }) => `${tools ? 'F' : '-'}${vision ? 'V' : '-'}${reasoning ? 'R' : '-'}`;

function renderModels(models) {
  if (!models.length) return 'Nenhum modelo encontrado.';
  const rows = models.map(model => [model.id, formatTokens(model.contextLength ?? NaN), formatTokens(model.maxOutputTokens ?? NaN),
    capabilityFlags(model.capabilities), prices(model.pricing, 'US$'), prices(model.pricingBrl, 'R$'),
    model.offer ? `${model.offer.type ?? 'oferta'}${model.offer.discountPercent ? ` -${model.offer.discountPercent}%` : ''}` : '-']);
  return `${table(['MODELO', 'CONTEXTO', 'SAÍDA', 'CAP', 'USD/1M ENTRADA / SAÍDA', 'BRL/1M ENTRADA / SAÍDA', 'OFERTA'], rows)}\nCAP: F ferramentas, V visão, R raciocínio. Preços por 1M de tokens.`;
}

export async function modelsCommand(ctx, args) {
  const { flags, values } = parseOptions(args, { flags: ['json', 'visao', 'ferramentas', 'decisao'], values: ['busca'] });
  const { base, key } = await resolveAuth(ctx);
  const { all } = await fetchCatalog(ctx, base, key);
  const models = filterModels(all, { busca: values.busca, visao: flags.visao, ferramentas: flags.ferramentas, decisao: flags.decisao });
  emit(ctx, flags.json, models, renderModels);
}
