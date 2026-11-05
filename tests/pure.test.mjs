// Funções puras: formatação, catálogo, opções, URL base. Inclui testes baseados em propriedades.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { formatBRL, formatPrice, formatTokens, formatCount, groupThousands, roundDecimal, table } from '../lib/format.mjs';
import { parseCatalog, filterModels, isDecisionModel, normalizeModel, piModel, opencodeModel, CHAT_ENDPOINTS } from '../lib/catalog.mjs';
import { normalizeBase } from '../lib/gateway.mjs';
import { parseOptions, QgError, isValidKey } from '../lib/util.mjs';
import { CATALOG, model } from './helpers.mjs';

const RUNS = { numRuns: 400 };

test('dinheiro: arredonda meio para longe do zero, sem ponto flutuante', () => {
  assert.equal(formatBRL('145.05489680807'), 'R$ 145,05');
  assert.equal(formatBRL('0.005'), 'R$ 0,01');
  assert.equal(formatBRL('1234567.8'), 'R$ 1.234.567,80');
  assert.equal(formatBRL('-0.001'), 'R$ 0,00');
  assert.equal(formatBRL('-2.5'), 'R$ -2,50');
  assert.equal(formatBRL('abc'), null);
  assert.equal(formatBRL('0'), 'R$ 0,00');
  assert.equal(formatPrice('1.25', 'US$'), 'US$ 1,25');
  assert.equal(formatPrice('6.8750', 'R$'), 'R$ 6,875');
  assert.equal(formatPrice('55', 'R$'), 'R$ 55,00');
  assert.equal(formatPrice('x', 'R$'), null);
  assert.equal(formatCount(1234567), '1.234.567');
  assert.equal(formatCount(Number.NaN), '-');
  assert.equal(formatTokens(200000), '200K');
  assert.equal(formatTokens(1500000), '1.5M');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(Number.NaN), '-');
  assert.equal(table(['A', 'BB'], [['x', 'yyy']]), 'A  BB\nx  yyy');
});

test('propriedade: formatBRL concorda com aritmética inteira em centavos', () => {
  fc.assert(fc.property(fc.nat({ max: 10 ** 9 }), fc.nat({ max: 99 }), fc.nat({ max: 999 }), (whole, cents, extra) => {
    const text = `${whole}.${String(cents).padStart(2, '0')}${String(extra).padStart(3, '0')}`;
    const expected = BigInt(whole) * 100n + BigInt(cents) + (extra >= 500 ? 1n : 0n);
    const digits = expected.toString().padStart(3, '0');
    assert.equal(formatBRL(text), `R$ ${groupThousands(digits.slice(0, -2))},${digits.slice(-2)}`);
  }), RUNS);
  fc.assert(fc.property(fc.nat({ max: 10 ** 6 }), n => roundDecimal(String(n), 2).fraction === '00'), RUNS);
});

test('catálogo: decisão sai de toda lista de chat e entra só com --decisao', () => {
  const { all, chat } = parseCatalog(CATALOG);
  assert.deepEqual(chat.map(m => m.id), ['gpt-6-luna', 'model-a']);
  assert.deepEqual(filterModels(all, { decisao: true }).map(m => m.id), ['systemone', 'decisor-2']);
  assert.deepEqual(filterModels(all, {}).map(m => m.id), ['gpt-6-luna', 'model-a']);
  assert.deepEqual(filterModels(all, { visao: true }).map(m => m.id), ['gpt-6-luna']);
  assert.deepEqual(filterModels(all, { ferramentas: true, busca: 'LUNA' }).map(m => m.id), ['gpt-6-luna']);
  assert.deepEqual(filterModels(all, { busca: 'zzz' }), []);
  assert.throws(() => parseCatalog({ data: [] }), QgError);
  assert.throws(() => parseCatalog({ data: [{ id: ' ' }] }), QgError);
  assert.throws(() => parseCatalog(null), QgError);
  assert.throws(() => parseCatalog({ data: [model('s', { type: 'decision' })] }), /sem modelos de chat/);
  assert.equal(parseCatalog({ data: [model('a'), model('a')] }).all.length, 1);
});

test('catálogo: normalização guarda null em vez de inventar zero', () => {
  const row = normalizeModel(model('x', { context_length: 0, max_output_tokens: 'abc', capabilities: null, pricing: { currency: 'USD', input: 'x', output: 3, input_cached: '0.5' }, pricing_brl: 7, offer: { type: 'a' } }));
  assert.equal(row.contextLength, null);
  assert.equal(row.maxOutputTokens, null);
  assert.deepEqual(row.capabilities, { tools: null, vision: null, reasoning: null });
  assert.deepEqual(row.pricing, { currency: 'USD', input: null, output: '3', cachedInput: '0.5' });
  assert.equal(row.pricingBrl, null);
  assert.deepEqual(row.offer, { type: 'a', discountPercent: null });
});

test('Pi e OpenCode usam o catálogo real e caem nos limites conservadores', () => {
  const rich = normalizeModel(CATALOG.data[0]);
  const bare = normalizeModel(model('model-a'));
  assert.deepEqual(piModel(rich), { id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: true, input: ['text', 'image'],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 });
  assert.deepEqual(piModel(bare), { id: 'model-a', name: 'model-a', reasoning: false, input: ['text'],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 });
  assert.equal(piModel(normalizeModel(model('z', { pricing: null }))).cost.input, 0);
  assert.equal(piModel(normalizeModel(model('z', { context_length: 1000, max_output_tokens: 9000 }))).maxTokens, 1000);
  assert.deepEqual(opencodeModel(rich), { name: 'GPT-6 Luna', limit: { context: 200000, output: 32000 }, tool_call: true, reasoning: true,
    attachment: true, modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 1.25, output: 10, cache_read: 0.125 } });
  assert.deepEqual(opencodeModel(normalizeModel(model('model-a', { pricing: null }))), { name: 'model-a' });
  assert.deepEqual(opencodeModel(normalizeModel(model('m', { context_length: 100, capabilities: { tools: false, vision: false, reasoning: false } }))).limit, { context: 100, output: 100 });
});

test('propriedade: filtro de catálogo só devolve modelos de chat ou só de decisão', () => {
  const endpoint = fc.constantFrom(...CHAT_ENDPOINTS, '/v1/decisions', '/v1/systemone', '/v1/embeddings');
  const raw = fc.record({ id: fc.stringMatching(/^[a-z0-9-]{1,12}$/), type: fc.constantFrom(undefined, 'decision', 'chat'),
    supported_endpoints: fc.option(fc.array(endpoint, { maxLength: 3 }), { nil: undefined }) });
  fc.assert(fc.property(fc.array(raw, { minLength: 1, maxLength: 12 }), items => {
    const all = items.map(item => normalizeModel(item));
    const chat = filterModels(all, {});
    const decision = filterModels(all, { decisao: true });
    assert.ok(chat.every(m => !isDecisionModel(m) && m.type !== 'decision'));
    assert.ok(decision.every(m => isDecisionModel(m)));
    assert.equal(chat.length + decision.length, all.length);
    assert.ok(chat.every(m => m.endpoints === null || m.endpoints.some(e => CHAT_ENDPOINTS.includes(e))));
  }), RUNS);
});

test('URL base: aceita raiz ou /v1, recusa credenciais, query, HTTP remoto', () => {
  assert.equal(normalizeBase('https://api.quebragalho.dev'), 'https://api.quebragalho.dev');
  assert.equal(normalizeBase('https://api.quebragalho.dev/v1/'), 'https://api.quebragalho.dev');
  assert.equal(normalizeBase('http://localhost:8080/v1'), 'http://localhost:8080');
  assert.equal(normalizeBase('http://[::1]:9'), 'http://[::1]:9');
  for (const bad of ['http://example.com', 'https://u:p@x.dev', 'https://x.dev/?a=1', 'https://x.dev/#f', 'nada', 'ftp://x.dev']) assert.throws(() => normalizeBase(bad), QgError, bad);
});

test('propriedade: URL base normalizada nunca termina em / nem em /v1 e é estável', () => {
  const host = fc.stringMatching(/^[a-z][a-z0-9]{0,10}\.(dev|com|io)$/);
  const path = fc.constantFrom('', '/', '/v1', '/v1/', '/api', '/api/v1');
  fc.assert(fc.property(host, path, fc.constantFrom('', ':8443'), (name, suffix, port) => {
    const base = normalizeBase(`https://${name}${port}${suffix}`);
    assert.ok(!base.endsWith('/') && !base.endsWith('/v1'));
    assert.ok(base.startsWith('https://'));
    assert.equal(normalizeBase(base), base);
    const url = new URL(base);
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
  }), RUNS);
});

test('opções: flags, valores, --x=y, erros claros', () => {
  const spec = { flags: ['json'], values: ['periodo'], max: 1 };
  assert.deepEqual(parseOptions(['modelo', '--json', '--periodo', '7d'], spec), { flags: { json: true }, values: { periodo: '7d' }, positional: ['modelo'] });
  assert.equal(parseOptions(['--periodo=30d'], spec).values.periodo, '30d');
  assert.throws(() => parseOptions(['--nada'], spec), /desconhecida/);
  assert.throws(() => parseOptions(['--periodo'], spec), /exige um valor/);
  assert.throws(() => parseOptions(['--periodo', '--json'], spec), /exige um valor/);
  assert.throws(() => parseOptions(['--json=1'], spec), /não recebe valor/);
  assert.throws(() => parseOptions(['a', 'b'], spec), /demais/);
  assert.ok(isValidKey('abc') && !isValidKey('a b') && !isValidKey('') && !isValidKey('a\nb') && !isValidKey(undefined));
});
