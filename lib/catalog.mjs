// Catálogo de modelos do gateway: normalização, filtro de modelos de decisão e metadados por harness.
import { QgError } from './util.mjs';

export const CHAT_ENDPOINTS = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
const FALLBACK_CONTEXT = 32768;
const FALLBACK_OUTPUT = 4096;

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = value => (Number.isInteger(value) && value > 0 ? value : null);
const flag = value => (typeof value === 'boolean' ? value : null);
const decimal = value => (['string', 'number'].includes(typeof value) && /^\d+(\.\d+)?$/.test(String(value)) ? String(value) : null);

function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { currency: text(raw.currency), input: decimal(raw.input), output: decimal(raw.output),
    cachedInput: decimal(raw.cached_input ?? raw.input_cached) };
}

export function normalizeModel(raw) {
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const offer = raw.offer && typeof raw.offer === 'object' ? { type: text(raw.offer.type),
    discountPercent: Number.isFinite(raw.offer.discount_percent) ? raw.offer.discount_percent : null } : null;
  return { id: raw.id, ownedBy: text(raw.owned_by), displayName: text(raw.display_name), type: text(raw.type),
    endpoints: Array.isArray(raw.supported_endpoints) ? raw.supported_endpoints.filter(e => typeof e === 'string') : null,
    contextLength: count(raw.context_length), maxOutputTokens: count(raw.max_output_tokens),
    capabilities: { tools: flag(capabilities.tools), vision: flag(capabilities.vision), reasoning: flag(capabilities.reasoning) },
    description: text(raw.description), acceptsBonus: flag(raw.accepts_bonus),
    pricing: normalizePricing(raw.pricing), pricingBrl: normalizePricing(raw.pricing_brl), offer };
}

// Modelos de decisão não fazem chat: nunca entram em seletor de harness.
export function isDecisionModel(model) {
  if (model.type === 'decision') return true;
  return Array.isArray(model.endpoints) && !model.endpoints.some(endpoint => CHAT_ENDPOINTS.includes(endpoint));
}

export function parseCatalog(body) {
  const data = body?.data;
  if (!Array.isArray(data) || !data.length || data.some(item => typeof item?.id !== 'string' || !item.id.trim())) throw new QgError('Catálogo inválido ou vazio.');
  const seen = new Set();
  const all = [];
  for (const item of data) if (!seen.has(item.id)) { seen.add(item.id); all.push(normalizeModel(item)); }
  const chat = all.filter(model => !isDecisionModel(model));
  if (!chat.length) throw new QgError('Catálogo sem modelos de chat.');
  return { all, chat };
}

export function filterModels(models, { busca, visao, ferramentas, decisao } = {}) {
  const needle = busca?.toLowerCase();
  return models.filter(model => {
    if (isDecisionModel(model) !== Boolean(decisao)) return false;
    if (visao && model.capabilities.vision !== true) return false;
    if (ferramentas && model.capabilities.tools !== true) return false;
    if (!needle) return true;
    return [model.id, model.displayName, model.ownedBy].some(field => field?.toLowerCase().includes(needle));
  });
}

const price = value => (value === null ? 0 : Number(value));

// Pi: custo em USD por 1M de tokens, limites do catálogo ou os conservadores.
export function piModel(model) {
  const context = model.contextLength ?? FALLBACK_CONTEXT;
  const usd = model.pricing?.currency === 'USD' ? model.pricing : null;
  return { id: model.id, name: model.displayName ?? model.id, reasoning: model.capabilities.reasoning === true,
    input: model.capabilities.vision === true ? ['text', 'image'] : ['text'],
    cost: { input: price(usd?.input ?? null), output: price(usd?.output ?? null), cacheRead: price(usd?.cachedInput ?? null), cacheWrite: 0 },
    contextWindow: context, maxTokens: Math.min(model.maxOutputTokens ?? FALLBACK_OUTPUT, context) };
}

// OpenCode: só inclui o que o catálogo informou.
export function opencodeModel(model) {
  const entry = { name: model.displayName ?? model.id };
  if (model.contextLength) entry.limit = { context: model.contextLength, output: Math.min(model.maxOutputTokens ?? FALLBACK_OUTPUT, model.contextLength) };
  if (model.capabilities.tools !== null) entry.tool_call = model.capabilities.tools;
  if (model.capabilities.reasoning !== null) entry.reasoning = model.capabilities.reasoning;
  if (model.capabilities.vision !== null) {
    entry.attachment = model.capabilities.vision;
    entry.modalities = { input: model.capabilities.vision ? ['text', 'image'] : ['text'], output: ['text'] };
  }
  const usd = model.pricing?.currency === 'USD' ? model.pricing : null;
  if (usd?.input !== null && usd?.output !== null && usd) {
    entry.cost = { input: price(usd.input), output: price(usd.output) };
    if (usd.cachedInput !== null) entry.cost.cache_read = price(usd.cachedInput);
  }
  return entry;
}
