// Formatação de dinheiro e tabelas sem ponto flutuante: valores do gateway são strings decimais.
export function groupThousands(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Arredonda (meio para longe do zero) uma string decimal para `places` casas. Devolve { negative, whole, fraction } ou null.
export function roundDecimal(text, places) {
  const match = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(String(text));
  if (!match) return null;
  const fraction = match[3] ?? '';
  let scaled = BigInt(match[2] + fraction);
  const extra = fraction.length - places;
  if (extra > 0) {
    const divisor = 10n ** BigInt(extra);
    scaled = scaled / divisor + (scaled % divisor * 2n >= divisor ? 1n : 0n);
  } else scaled *= 10n ** BigInt(-extra);
  const digits = scaled.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  return { negative: Boolean(match[1]) && scaled > 0n, whole, fraction: digits.slice(digits.length - places) };
}

export function formatBRL(text) {
  const rounded = roundDecimal(text, 2);
  if (!rounded) return null;
  return `R$ ${rounded.negative ? '-' : ''}${groupThousands(rounded.whole)},${rounded.fraction}`;
}

// Preço por 1M de tokens: até 4 casas, no mínimo 2, vírgula decimal.
export function formatPrice(text, symbol) {
  const rounded = roundDecimal(text, 4);
  if (!rounded) return null;
  const fraction = rounded.fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${symbol} ${groupThousands(rounded.whole)},${fraction}`;
}

export function formatCount(value) {
  return Number.isFinite(value) ? groupThousands(String(Math.trunc(value))) : '-';
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1e6) return `${+(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${+(value / 1e3).toFixed(1)}K`;
  return String(value);
}

export function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map(row => String(row[column]).length)));
  return all.map(row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}
