/**
 * Helpers puros do webhook Guru: extrair src, plano e telefone do payload.
 * Sem I/O — testável sem rede.
 */

export function extractProductId(payload) {
  const p = payload?.product;
  if (p == null) return null;
  if (typeof p === 'string') return p.trim() || null;
  return p.internal_id || p.id || null;
}

export function extractInstances(planName) {
  if (!planName) return null;
  const match = String(planName).match(/(\d+)\s*conex/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

/**
 * O `src` do checkout (?src=<account_id>) aparece em formas diferentes
 * no webhook vs na API da Guru (`source` vs `trackings`).
 */
export function extractSrc(payload) {
  const sourceObj = payload?.source && typeof payload.source === 'object' ? payload.source : null;
  const candidates = [
    payload?.src,
    typeof payload?.source === 'string' ? payload.source : null,
    sourceObj?.source,
    sourceObj?.src,
    sourceObj?.utm_source,
    payload?.subscription?.src,
    payload?.transaction?.src,
    payload?.tracking?.src,
    payload?.tracking?.source,
    payload?.trackings?.src,
    payload?.trackings?.source,
    payload?.transaction?.tracking?.source,
    payload?.transaction?.tracking?.src,
    payload?.transaction?.trackings?.source,
    payload?.metadata?.src,
    payload?.checkout?.src,
    payload?.contact?.tracking?.source,
    payload?.contact?.tracking_source
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return null;
}

/** Telefones do contato Guru em formatos que a API Leona aceita. */
export function extractContactPhones(payload) {
  const raw = payload?.contact?.phone_number ?? payload?.subscription?.subscriber?.phone_number;
  if (raw == null) return [];
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return [];

  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };

  push(digits);
  push(`+${digits}`);

  // DDI 55 no phone_number: a Leona guarda só o nacional (+1191...).
  if (digits.startsWith('55') && digits.length >= 12) {
    const national = digits.slice(2);
    push(national);
    push(`+${national}`);
  }

  const ddi = String(payload?.contact?.phone_local_code || '').replace(/\D/g, '');
  if (ddi && !digits.startsWith(ddi)) {
    push(ddi + digits);
  }

  return out;
}

export function summarizeGuruWebhook(payload) {
  return {
    webhook_type: payload?.webhook_type || null,
    status: payload?.status || payload?.subscription?.last_status || null,
    email: payload?.contact?.email || payload?.subscription?.subscriber?.email || null,
    src: extractSrc(payload),
    product_id: extractProductId(payload),
    subscription_id: payload?.subscription?.internal_id || payload?.subscription?.id || null,
    invoice_type: payload?.invoice?.type || null
  };
}
