/**
 * Preço Leona Starter em centavos BRL.
 * 1 = R$ 127; 2–3 = R$ 99/ea; 4+ = R$ 79/ea.
 */
export function leonaAmountCents(qty) {
  const n = Math.max(1, Number(qty) || 1);
  if (n <= 1) return 12700;
  if (n <= 3) return 99 * n * 100;
  return 79 * n * 100;
}

export function reaisToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function dueDatePlusDays(days = 30) {
  const ms = Date.now() + days * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export function parseLeonaRef(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^leona:([^:]+):(\d+)(?::.*)?$/i);
  if (!m) return null;
  return { accountId: m[1], qty: Number(m[2]) };
}

export function makeLeonaRef(accountId, qty) {
  return `leona:${accountId}:${qty}`;
}

export function leonaAmountReais(qty) {
  return leonaAmountCents(qty) / 100;
}

/**
 * Mesma conta da /assinatura: (novo − atual) × min(dias restantes, 30) / 30.
 * Teto = diferença mensal — ciclo com 31 dias não cobra mais que o mês cheio.
 */
export function calcLeonaProrata(currentValue, newValue, periodEnd, now = new Date()) {
  const end = new Date(periodEnd);
  const diasRestantes = Number.isNaN(end.getTime())
    ? 0
    : Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));
  const diasNoCiclo = 30;
  const diasCobrados = Math.min(diasRestantes, diasNoCiclo);
  const current = Number(currentValue) || 0;
  const next = Number(newValue) || 0;
  const monthlyDiff = next - current;
  let proRata = monthlyDiff * diasCobrados / diasNoCiclo;
  if (monthlyDiff >= 0) proRata = Math.min(proRata, monthlyDiff);
  else proRata = Math.max(proRata, monthlyDiff);
  return {
    proRata: Math.round(proRata * 100) / 100,
    diasRestantes,
    diasNoCiclo,
    diasCobrados
  };
}
