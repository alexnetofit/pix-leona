import {
  GURU_BASE,
  LEONA_GURU_PRODUCT_ID,
  findGuruContactByEmail,
  guruHeaders,
  resolveGuruTransactionPaidAt
} from './guru.js';
import { listCustomersByEmail, listTransactions } from './paddle-client.js';

export const TRILHA_MIN_PAID_MONTHS = 3;
export const TRILHA_DEMO_INELIGIBLE_ACCOUNTS = new Set(['1234']);

function isLeonaGuruTransaction(t) {
  const pid = t?.product?.internal_id || t?.product?.id;
  return pid === LEONA_GURU_PRODUCT_ID;
}

function paddleTransactionIsLeona(transaction) {
  const configuredPrices = new Set([
    process.env.PADDLE_STARTER_PRICE_ID,
    process.env.PADDLE_PIX_PRICE_ID
  ].filter(Boolean));
  const items = Array.isArray(transaction?.items) ? transaction.items : [];
  const lineItems = Array.isArray(transaction?.details?.line_items)
    ? transaction.details.line_items
    : [];
  return items.some(item =>
    configuredPrices.has(item?.price?.id)
    || String(item?.product?.name || '').toLowerCase() === 'leona flow'
  ) || lineItems.some(item =>
    configuredPrices.has(item?.price_id)
    || String(item?.product?.name || '').toLowerCase() === 'leona flow'
  ) || Boolean(transaction?.custom_data?.leona_account_id);
}

function guruCycleKey(t) {
  if (t?.status !== 'approved') return null;
  const sub = t.subscription?.internal_id || t.subscription?.id || 'sem-sub';
  if (t.invoice?.cycle != null) return `guru:${sub}:c${t.invoice.cycle}`;
  const start = t.invoice?.period_start || resolveGuruTransactionPaidAt(t);
  if (!start) return null;
  return `guru:${sub}:m${String(start).slice(0, 7)}`;
}

function paddleCycleKey(t) {
  if (String(t?.status || '').toLowerCase() !== 'completed') return null;
  if (!paddleTransactionIsLeona(t)) return null;

  const origin = String(t.origin || '').toLowerCase();
  // Upgrades / prorata na mesma assinatura não contam como mês extra.
  if (origin.includes('update') || origin.includes('proration')) return null;

  const sub = t.subscription_id || 'prepaid';
  const start = t.billing_period?.starts_at || t.billed_at || t.created_at;
  if (!start) return null;
  return `paddle:${sub}:m${String(start).slice(0, 7)}`;
}

export async function fetchGuruPaidCycleKeys(email, guruToken) {
  if (!email || !guruToken) return { keys: new Set(), error: null };

  try {
    const contact = await findGuruContactByEmail(email, guruToken);
    if (!contact) return { keys: new Set(), error: null };

    const r = await fetch(
      `${GURU_BASE}/transactions?contact_id=${encodeURIComponent(contact.id)}&limit=100`,
      { headers: guruHeaders(guruToken) }
    );
    if (!r.ok) return { keys: new Set(), error: `Guru HTTP ${r.status}` };

    const body = await r.json();
    const txs = Array.isArray(body.data) ? body.data : [];
    const keys = new Set();

    for (const t of txs) {
      if (!isLeonaGuruTransaction(t)) continue;
      const key = guruCycleKey(t);
      if (key) keys.add(key);
    }

    return { keys, error: null };
  } catch (error) {
    return { keys: new Set(), error: error.message || 'erro_guru' };
  }
}

export async function fetchPaddlePaidCycleKeys(email) {
  if (!email || !process.env.PADDLE_API_KEY) return { keys: new Set(), error: null };

  try {
    const customers = await listCustomersByEmail(email.trim().toLowerCase());
    const keys = new Set();

    for (const customer of customers) {
      const txs = await listTransactions({
        customer_id: customer.id,
        status: 'completed',
        per_page: 100,
        order_by: 'billed_at[DESC]'
      });

      for (const t of txs) {
        const key = paddleCycleKey(t);
        if (key) keys.add(key);
      }
    }

    return { keys, error: null };
  } catch (error) {
    return { keys: new Set(), error: error.message || 'erro_paddle' };
  }
}

export function mergePaidCycleKeys(guruKeys, paddleKeys) {
  return new Set([...guruKeys, ...paddleKeys]);
}

export function buildTrilhaRedeemEligibility({
  accountId,
  paidMonths,
  requiredMonths = TRILHA_MIN_PAID_MONTHS,
  sources = {},
  errors = []
}) {
  const demoBlocked = TRILHA_DEMO_INELIGIBLE_ACCOUNTS.has(String(accountId || '').trim());
  const eligible = !demoBlocked && paidMonths >= requiredMonths;

  let message;
  if (demoBlocked) {
    message = `Exemplo demo: ${paidMonths} ${paidMonths === 1 ? 'mês pago' : 'meses pagos'} — faltam ${Math.max(0, requiredMonths - paidMonths)} para resgatar.`;
  } else if (eligible) {
    message = `${paidMonths} meses pagos confirmados. Você pode resgatar os prêmios desbloqueados.`;
  } else {
    message = `Para resgatar, é preciso ter pelo menos ${requiredMonths} meses pagos no Leona (renovações, sem contar upgrades). Você tem ${paidMonths}.`;
  }

  return {
    eligible,
    required_months: requiredMonths,
    paid_months: paidMonths,
    missing_months: Math.max(0, requiredMonths - paidMonths),
    message,
    demo: demoBlocked,
    sources,
    errors
  };
}

export async function resolveTrilhaRedeemEligibility({ accountId, email, guruToken }) {
  if (TRILHA_DEMO_INELIGIBLE_ACCOUNTS.has(String(accountId || '').trim())) {
    return buildTrilhaRedeemEligibility({
      accountId,
      paidMonths: 1,
      sources: { guru: 1, paddle: 0, demo: true },
      errors: []
    });
  }

  const [guru, paddle] = await Promise.all([
    fetchGuruPaidCycleKeys(email, guruToken),
    fetchPaddlePaidCycleKeys(email)
  ]);

  const merged = mergePaidCycleKeys(guru.keys, paddle.keys);
  const errors = [guru.error, paddle.error].filter(Boolean);

  return buildTrilhaRedeemEligibility({
    accountId,
    paidMonths: merged.size,
    sources: {
      guru: guru.keys.size,
      paddle: paddle.keys.size,
      total: merged.size
    },
    errors
  });
}
