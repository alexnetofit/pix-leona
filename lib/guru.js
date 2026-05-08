/**
 * lib/guru.js - Helpers compartilhados para chamar a API da Digital Manager Guru.
 *
 * Reusados pelo paddle-search (pra mostrar status Guru no painel /paddle) e
 * pelo webhook-paddle (pra cancelar a sub Guru automaticamente quando o
 * cliente migra pra Paddle).
 *
 * Auth: Bearer Token (env GURU_TOKEN). Base URL fixa no produto.
 */

export const GURU_BASE = 'https://digitalmanager.guru/api/v2';

// Produto Leona Flow na Guru — todos os filtros usam esse ID pra evitar
// retornar subs/transações de outros produtos do mesmo workspace.
export const LEONA_GURU_PRODUCT_ID = 'a1869b83-b28d-4257-a986-1df94558a152';

export function guruHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'n8n'
  };
}

/**
 * Busca o contato Guru pelo email. Devolve o objeto contact ou null.
 */
export async function findGuruContactByEmail(email, guruToken) {
  if (!email || !guruToken) return null;
  const emailClean = email.trim().toLowerCase();

  try {
    const r = await fetch(
      `${GURU_BASE}/contacts?email=${encodeURIComponent(emailClean)}&limit=20`,
      { headers: guruHeaders(guruToken) }
    );
    if (!r.ok) return null;
    const body = await r.json();
    const contacts = Array.isArray(body.data) ? body.data : [];
    return contacts.find(c => c.email?.toLowerCase() === emailClean) || null;
  } catch (e) {
    console.error('findGuruContactByEmail: erro:', e.message);
    return null;
  }
}

/**
 * Lista todas as subs Guru do produto Leona pra um email, filtradas por
 * status (default: somente "active"). Devolve array já normalizado.
 */
export async function findGuruSubscriptionsByEmail(email, guruToken, opts = {}) {
  const { onlyActive = true } = opts;
  const contact = await findGuruContactByEmail(email, guruToken);
  if (!contact) return [];

  try {
    const r = await fetch(
      `${GURU_BASE}/subscriptions?contact_id=${contact.id}&limit=50`,
      { headers: guruHeaders(guruToken) }
    );
    if (!r.ok) return [];
    const body = await r.json();
    const subs = Array.isArray(body.data) ? body.data : [];
    const leonaSubs = subs.filter(s => s.product?.id === LEONA_GURU_PRODUCT_ID);
    const filtered = onlyActive
      ? leonaSubs.filter(s => s.last_status === 'active')
      : leonaSubs;
    // Converte timestamps Unix em segundos pra ISO 8601 (mais legivel pra
    // humano e LLM). cycle_start_date/cycle_end_date/next_cycle_at vem como
    // string YYYY-MM-DD direto da Guru (deixamos como esta).
    const tsToIso = (ts) => {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return null;
      return new Date(n * 1000).toISOString();
    };
    return filtered.map(s => ({
      id: s.id,
      subscription_code: s.subscription_code,
      status: s.last_status,
      status_at: tsToIso(s.last_status_at),
      offer_id: s.offer?.id || s.product?.offer?.id || null,
      offer_name: s.offer?.name || s.product?.offer?.name || null,
      product_id: s.product?.id || null,
      product_name: s.product?.name || null,
      payment_method: s.payment_method,
      cycle_start: s.cycle_start_date,
      cycle_end: s.cycle_end_date,
      next_cycle: s.next_cycle_at,
      cancelled_at: tsToIso(s.cancelled_at)
    }));
  } catch (e) {
    console.error('findGuruSubscriptionsByEmail: erro:', e.message);
    return [];
  }
}

/**
 * Atalho que devolve só as subs ativas (uso mais comum).
 */
export function findGuruActiveSubscriptionsByEmail(email, guruToken) {
  return findGuruSubscriptionsByEmail(email, guruToken, { onlyActive: true });
}

/**
 * Atualiza dados de um contato Guru (email, doc, name, etc).
 *
 * Endpoint: PUT /contacts/:id (Guru aceita atualizacao parcial).
 *
 * Trata o caso de erro de DUPLICIDADE de documento — se outro contato
 * ja existe com o mesmo doc, a Guru retorna 422/409 com mensagem do tipo
 * "doc has already been taken". Nesse caso, retentamos alterando o ULTIMO
 * digito do doc (incrementando 0->1, 9->8 quando 0 nao funciona) ate
 * resolver ou esgotar tentativas.
 *
 * payload deve conter os campos a atualizar, ex: { email, doc, name }
 *
 * Retorna { ok, status, body, attempts, final_doc } pra debug.
 */
export async function updateGuruContact(contactId, payload, guruToken, opts = {}) {
  if (!contactId || !guruToken) {
    return { ok: false, error: 'sem contactId ou token' };
  }
  const { maxDocRetries = 10 } = opts;

  const isDuplicateError = (status, body) => {
    if (status !== 422 && status !== 409) return false;
    const msg = JSON.stringify(body || {}).toLowerCase();
    return msg.includes('already') || msg.includes('duplicad') || msg.includes('taken') || msg.includes('existe');
  };

  let attempts = 0;
  let body = { ...payload };
  let docVariations = 0;

  while (attempts < (maxDocRetries + 1)) {
    attempts++;
    try {
      const r = await fetch(`${GURU_BASE}/contacts/${encodeURIComponent(contactId)}`, {
        method: 'PUT',
        headers: guruHeaders(guruToken),
        body: JSON.stringify(body)
      });
      const respBody = await r.json().catch(() => ({}));

      if (r.ok) {
        return { ok: true, status: r.status, body: respBody, attempts, final_doc: body.doc || null };
      }

      // Duplicidade: incrementa ultimo digito do doc e tenta de novo.
      if (body.doc && isDuplicateError(r.status, respBody) && docVariations < maxDocRetries) {
        const oldDoc = String(body.doc);
        const lastDigit = oldDoc.slice(-1);
        if (/^\d$/.test(lastDigit)) {
          // Cicla 0->1->2... e quando chega em 9, vai pra 8 (evita 10).
          let next = (parseInt(lastDigit, 10) + 1) % 10;
          if (next === parseInt(lastDigit, 10)) next = (next + 1) % 10;
          const newDoc = oldDoc.slice(0, -1) + String(next);
          body = { ...body, doc: newDoc };
          docVariations++;
          continue;
        }
      }

      return {
        ok: false,
        status: r.status,
        body: respBody,
        attempts,
        final_doc: body.doc || null,
        error: respBody?.message || respBody?.error || `Guru retornou ${r.status}`
      };
    } catch (e) {
      return { ok: false, error: e.message, attempts, final_doc: body.doc || null };
    }
  }

  return { ok: false, error: 'esgotou tentativas de variacao de doc', attempts, final_doc: body.doc || null };
}

/**
 * Cancela uma subscription Guru via POST /subscriptions/:id/cancel.
 *
 * IMPORTANTE: a doc/n8n-node sugere DELETE /subscriptions/:id, mas esse
 * endpoint nao existe na API real (responde 404 "Page not found" em
 * qualquer metodo). Probamos os metodos e so POST /cancel responde 401
 * sem token (ou seja, a rota existe). Usar POST /cancel.
 *
 * Aceita tanto o `id` (UUID) quanto o `subscription_code` (sub_xxx).
 *
 * Devolve { ok, status, body } padronizado pra fácil tratamento de erro.
 */
export async function cancelGuruSubscription(subscriptionId, guruToken, opts = {}) {
  if (!subscriptionId || !guruToken) {
    return { ok: false, error: 'sem subscription_id ou token' };
  }
  // A Guru exige no body:
  //   cancel_at_cycle_end: boolean
  //     true  -> cancela no fim do ciclo (cliente continua ate vencer)
  //     false -> cancela imediato
  //   comment: string (motivo do cancelamento, registrado no painel)
  // Default: cancelamento imediato com comment generico — webhook-paddle
  // (migracao automatica) usa esse default.
  const {
    cancel_at_cycle_end = false,
    comment = 'Cancelamento via integracao Leona'
  } = opts;
  try {
    const r = await fetch(
      `${GURU_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: 'POST',
        headers: guruHeaders(guruToken),
        body: JSON.stringify({ cancel_at_cycle_end, comment })
      }
    );
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
