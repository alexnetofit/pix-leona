/**
 * Planos mensais Leona na Pagar.me (um por qty).
 * Payment link type=subscription exige plan_id.
 */
import { leonaAmountCents } from './leona-pricing.js';
import { createPagarmePlan, listAllPagarmePlans } from './pagarme.js';

export const PAGARME_PLAN_PREFIX = 'leona-starter-';

const planCache = new Map();

export function pagarmePlanCodeForQty(qty) {
  return `${PAGARME_PLAN_PREFIX}${Math.max(1, Number(qty) || 1)}`;
}

export function pagarmePlanNameForQty(qty) {
  const n = Math.max(1, Number(qty) || 1);
  return `Leona Flow — ${n} conex${n === 1 ? 'ão' : 'ões'}`;
}

export function buildPagarmePlanPayload(qty) {
  const n = Math.max(1, Number(qty) || 1);
  const name = pagarmePlanNameForQty(n).slice(0, 64);
  return {
    name,
    description: pagarmePlanCodeForQty(n),
    currency: 'BRL',
    interval: 'month',
    interval_count: 1,
    billing_type: 'prepaid',
    payment_methods: ['credit_card'],
    installments: [1],
    items: [{
      name,
      quantity: 1,
      pricing_scheme: {
        scheme_type: 'unit',
        price: leonaAmountCents(n)
      }
    }],
    metadata: {
      code: pagarmePlanCodeForQty(n),
      qty: String(n)
    }
  };
}

export function pagarmePlanMatchesQty(plan = {}, qty) {
  const n = Math.max(1, Number(qty) || 1);
  const code = pagarmePlanCodeForQty(n);
  if (String(plan.metadata?.code || '') === code) return true;
  if (String(plan.description || '') === code) return true;
  const price = Number(plan.items?.[0]?.pricing_scheme?.price);
  return String(plan.name || '') === pagarmePlanNameForQty(n)
    && price === leonaAmountCents(n);
}

function cachePlan(qty, plan) {
  if (plan?.id) planCache.set(Math.max(1, Number(qty) || 1), plan);
  return plan;
}

export async function ensurePagarmePlanForQty(qty) {
  const n = Math.max(1, Number(qty) || 1);
  const cached = planCache.get(n);
  if (cached?.id) return { ok: true, created: false, plan: cached };

  let listed;
  try {
    listed = await listAllPagarmePlans({ status: 'active' });
  } catch (err) {
    return { ok: false, created: false, plan: null, error: err.message };
  }
  const found = listed.rows.find((plan) => pagarmePlanMatchesQty(plan, n));
  if (found) {
    return { ok: true, created: false, plan: cachePlan(n, found) };
  }

  const created = await createPagarmePlan(buildPagarmePlanPayload(n));
  if (created.ok && created.body?.id) {
    return { ok: true, created: true, plan: cachePlan(n, created.body) };
  }

  try {
    const retry = await listAllPagarmePlans({ status: 'active' });
    const raced = retry.rows.find((plan) => pagarmePlanMatchesQty(plan, n));
    if (raced) return { ok: true, created: false, plan: cachePlan(n, raced) };
  } catch {
    /* ignore */
  }

  return {
    ok: false,
    created: false,
    plan: null,
    status: created.status,
    body: created.body,
    error: created.body?.message || created.body?.error || 'Falha ao criar plano na Pagar.me'
  };
}
