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
    return filtered.map(s => ({
      id: s.id,
      subscription_code: s.subscription_code,
      status: s.last_status,
      status_at: s.last_status_at,
      offer_id: s.offer?.id || s.product?.offer?.id || null,
      offer_name: s.offer?.name || s.product?.offer?.name || null,
      payment_method: s.payment_method,
      cycle_start: s.cycle_start_date,
      cycle_end: s.cycle_end_date,
      next_cycle: s.next_cycle_at,
      cancelled_at: s.cancelled_at
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
 * Cancela uma subscription Guru via DELETE /subscriptions/:id.
 * Devolve { ok, status, body } padronizado pra fácil tratamento de erro.
 */
export async function cancelGuruSubscription(subscriptionId, guruToken) {
  if (!subscriptionId || !guruToken) {
    return { ok: false, error: 'sem subscription_id ou token' };
  }
  try {
    const r = await fetch(
      `${GURU_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: 'DELETE', headers: guruHeaders(guruToken) }
    );
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
