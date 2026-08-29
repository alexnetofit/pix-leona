/**
 * Últimos pagamentos Pagar.me / Paddle da /assinatura.
 * Normaliza pra o mesmo shape que o helper de qty lê.
 */
import { pagarmeConfigured, pagarmeRequest } from './pagarme.js';
import { qtyFromPayment } from './assinatura-qty.js';

const PADDLE_BASE = 'https://api.paddle.com';
const PADDLE_PAID = new Set(['completed', 'billed', 'paid']);

function paddleHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  };
}

function accountFromLeonaCode(code) {
  const raw = String(code || '').trim();
  const dashed = raw.match(/^leona-(.+)-(\d+)-(prorata|sub)$/i);
  return dashed ? dashed[1] : null;
}

function matchesAccount(rowAccountId, wantedIds) {
  if (!wantedIds?.length) return true;
  if (!rowAccountId) return false;
  return wantedIds.includes(String(rowAccountId));
}

export function pagarmeOrderToPayment(order, accountIds = []) {
  const status = String(order?.status || '').toLowerCase();
  if (status !== 'paid') return null;

  const code = String(order?.code || '');
  const accountId = accountFromLeonaCode(code);
  if (!matchesAccount(accountId, accountIds)) return null;

  const item = Array.isArray(order.items) ? order.items[0] : null;
  const charge = Array.isArray(order.charges) ? order.charges[0] : null;
  const kind = /-(prorata)$/i.test(code) ? 'one_shot' : 'subscription';
  const row = {
    provider: 'pagarme',
    status: 'paid',
    account_id: accountId,
    code,
    kind,
    offer_name: item?.description || '',
    item_quantity: item?.quantity ?? null,
    paid_at: charge?.paid_at || order.updated_at || order.created_at || ''
  };
  row.qty = qtyFromPayment(row);
  return row.qty ? row : null;
}

export function paddleTxToPayment(tx, accountIds = []) {
  const status = String(tx?.status || '').toLowerCase();
  if (!PADDLE_PAID.has(status)) return null;

  const customData = tx?.custom_data && typeof tx.custom_data === 'object' ? tx.custom_data : {};
  const accountId = customData.leona_account_id || customData.account_id || null;
  if (!matchesAccount(accountId, accountIds)) return null;

  const item = Array.isArray(tx.items) ? tx.items[0] : null;
  const row = {
    provider: 'paddle',
    status: 'paid',
    account_id: accountId ? String(accountId) : null,
    kind: customData.kind || null,
    qty: customData.qty != null ? Number(customData.qty) : null,
    offer_name: item?.price_name || item?.price?.name || item?.price?.description || '',
    item_quantity: item?.quantity ?? null,
    custom_data: customData,
    paid_at: tx.billed_at || tx.created_at || ''
  };
  row.qty = qtyFromPayment(row);
  return row.qty ? row : null;
}

async function listPagarmePayments(email, accountIds) {
  if (!pagarmeConfigured() || !email) return [];
  const customers = await pagarmeRequest(
    'GET',
    `/customers?email=${encodeURIComponent(email)}`
  );
  if (!customers.ok) return [];
  const list = Array.isArray(customers.body?.data) ? customers.body.data : [];
  const customer = list.find((c) => String(c.email || '').toLowerCase() === email) || list[0];
  if (!customer?.id) return [];

  const orders = await pagarmeRequest('GET', `/orders?customer_id=${customer.id}&size=30`);
  if (!orders.ok) return [];
  const rows = Array.isArray(orders.body?.data) ? orders.body.data : [];
  return rows.map((order) => pagarmeOrderToPayment(order, accountIds)).filter(Boolean);
}

async function listPaddlePayments(email, accountIds) {
  const token = String(process.env.PADDLE_API_KEY || '').trim();
  if (!token || !email) return [];
  const headers = paddleHeaders(token);
  const customersRes = await fetch(
    `${PADDLE_BASE}/customers?email=${encodeURIComponent(email)}`,
    { headers }
  );
  if (!customersRes.ok) return [];
  const customersBody = await customersRes.json().catch(() => ({}));
  const customers = Array.isArray(customersBody.data) ? customersBody.data : [];
  const customer = customers.find((c) => String(c.email || '').toLowerCase() === email) || customers[0];
  if (!customer?.id) return [];

  const txRes = await fetch(
    `${PADDLE_BASE}/transactions?customer_id=${customer.id}&per_page=30&order_by=billed_at[DESC]`,
    { headers }
  );
  if (!txRes.ok) return [];
  const txBody = await txRes.json().catch(() => ({}));
  const txs = Array.isArray(txBody.data) ? txBody.data : [];
  return txs.map((tx) => paddleTxToPayment({
    ...tx,
    items: (tx.items || []).map((it) => ({
      quantity: it.quantity,
      price_name: it.price?.name || it.price?.description || null,
      price: it.price
    }))
  }, accountIds)).filter(Boolean);
}

export async function listAssinaturaPayments({ email, accountIds = [] } = {}) {
  const emailClean = String(email || '').trim().toLowerCase();
  const ids = [...new Set((accountIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!emailClean) return [];
  const [pagarme, paddle] = await Promise.all([
    listPagarmePayments(emailClean, ids).catch((err) => {
      console.error('assinatura-payments pagarme:', err.message);
      return [];
    }),
    listPaddlePayments(emailClean, ids).catch((err) => {
      console.error('assinatura-payments paddle:', err.message);
      return [];
    })
  ]);
  return [...pagarme, ...paddle];
}

export function shouldLoadAssinaturaPayments(profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return true;
  return profiles.some((p) => !(Number(p?.starter_instances) > 0));
}
