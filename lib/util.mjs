// Erros mostrados ao usuário e leitura de opções da linha de comando.
export class QgError extends Error {
  constructor(message) { super(message); this.name = 'QgError'; }
}

export function fail(message) { throw new QgError(message); }

// Valida chaves coladas ou recebidas do servidor: ASCII visível, até 512 caracteres.
export const isValidKey = key => typeof key === 'string' && /^[\x21-\x7e]{1,512}$/.test(key);

// Lê JSON limitando o tamanho do corpo; undefined se grande demais ou inválido.
export async function readJsonBounded(response, maxChars = 1 << 20) {
  try {
    const text = await response.text();
    return text.length > maxChars ? undefined : JSON.parse(text);
  } catch { return undefined; }
}

// Texto vindo do servidor para o terminal: sem caracteres de controle nem sequências de escape.
export const printable = (value, max = 300) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max);

// spec: { flags: ['json'], values: ['periodo'], max: 1 } -> { flags, values, positional }
export function parseOptions(args, spec = {}) {
  const flags = {};
  const values = {};
  const positional = [];
  const known = [...(spec.flags ?? []), ...(spec.values ?? [])];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!known.includes(name)) fail(`Opção desconhecida: --${name.slice(0, 40)}.`);
    if (spec.flags?.includes(name)) {
      if (inline !== undefined) fail(`--${name} não recebe valor.`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) fail(`--${name} exige um valor.`);
    values[name] = value;
  }
  if (positional.length > (spec.max ?? 0)) fail('Argumentos demais. Use --help.');
  return { flags, values, positional };
}

export const asJson = value => `${JSON.stringify(value, null, 2)}`;
