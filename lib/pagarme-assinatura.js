/**
 * Checkout Pagar.me (Stone) da /assinatura — avulso, igual as placas.
 * Pró-rata e vencimento iguais à dLocal Go.
 */
import { activateLeonaAndCancelLegacy } from './activate-after-payment.js';
import { logAssinaturaEvent } from './assinatura-log.js';
import {
  calcLeonaProrata,
  dueDatePlusDays,
  leonaAmountCents,
  leonaAmountReais,
  reaisToCents
} from './leona-pricing.js';
import { isOneShotKind } from './dlocal-go.js';
import { notifyAffiliatesPagou } from './notify-affiliates.js';
import {
  createPagarmePaymentLink,
  getPagarmePaymentLink
} from './pagarme.js';
import { paymentLinkLooksPaid } from './trilha-fulfill.js';
import { sbConfigured, sbInsert, sbSelect, sbUpdate } from './supabase.js';

function laterDate(left, right) {
  const a = left ? String(left).slice(0, 10) : '';
  const b = right ? String(right).slice(0, 10) : '';
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

export function resolvePagarmeAssinaturaCharge({
  qty,
  kind,
  amount,
  profile,
  now = new Date()
} = {}) {
  const qtyN = Math.max(1, Number(qty) || 0);
  if (!qtyN) return { ok: false, error: 'qty obrigatória' };

  const oneShot = isOneShotKind(kind);
  const fullCents = leonaAmountCents(qtyN);
  const currentQty = Number(profile?.starter_instances || 0);
  const currentEnd = profile?.current_period_end || null;
  const cycleOpen = Boolean(currentEnd && new Date(currentEnd) > now);
  const qtyChanged = currentQty > 0 && qtyN !== currentQty;

  if (oneShot && cycleOpen && qtyChanged) {
    const calc = calcLeonaProrata(
      leonaAmountReais(currentQty),
      leonaAmountReais(qtyN),
      currentEnd,
      now
    );
    const amountCents = Math.round(calc.proRata * 100);
    if (amountCents <= 0) {
      return { ok: false, error: 'ajuste sem valor a cobrar' };
    }
    return {
      ok: true,
      qty: qtyN,
      oneShot: true,
      amountCents,
      keepCycle: true,
      dueDate: String(currentEnd).slice(0, 10),
      productName: `Ajuste Leona — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`,
      prorata: calc
    };
  }

  const customCents = reaisToCents(amount);
  const amountCents = oneShot && customCents ? customCents : fullCents;
  if (!amountCents || amountCents <= 0) {
    return { ok: false, error: 'amount obrigatório no ajuste proporcional' };
  }
  return {
    ok: true,
    qty: qtyN,
    oneShot,
    amountCents,
    keepCycle: false,
    dueDate: null,
    productName: oneShot
      ? `Ajuste Leona — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`
      : `Leona Flow — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`
  };
}

export function buildPagarmeAssinaturaLinkPayload({
  accountId,
  qty,
  oneShot,
  amountCents,
  productName,
  customer
}) {
  const title = `Leona ${accountId} x${qty} ${oneShot ? 'ajuste' : 'plano'}`.slice(0, 64);
  return {
    type: 'order',
    name: title,
    max_paid_sessions: 1,
    expires_in: 180,
    payment_settings: {
      accepted_payment_methods: ['pix', 'credit_card'],
      pix_settings: { expires_in: 3600 },
      credit_card_settings: {
        operation_type: 'auth_and_capture',
        installments_setup: {
          interest_type: 'simple',
          amount: amountCents,
          max_installments: 1,
          interest_rate: 0
        }
      }
    },
    customer_settings: {
      customer: {
        name: String(customer?.name || 'Cliente Leona').slice(0, 64),
        email: String(customer?.email || '').trim().toLowerCase()
      }
    },
    cart_settings: {
      shipping_cost: 0,
      items: [{
        name: String(productName).slice(0, 64),
        description: title,
        amount: amountCents,
        default_quantity: 1,
        code: `leona-${accountId}-${qty}-${oneShot ? 'prorata' : 'sub'}`
      }]
    }
  };
}

export async function createPagarmeAssinaturaCheckout({
  accountId,
  email,
  name,
  qty,
  kind,
  amount,
  profile
}) {
  const charge = resolvePagarmeAssinaturaCharge({ qty, kind, amount, profile });
  if (!charge.ok) return charge;

  const customer = {
    name: String(name || profile?.user?.name || 'Cliente Leona').trim().slice(0, 64),
    email: String(email || profile?.user?.email || '').trim().toLowerCase()
  };
  if (!customer.email || !customer.email.includes('@')) {
    return { ok: false, error: 'E-mail da conta Leona inválido' };
  }

  const payload = buildPagarmeAssinaturaLinkPayload({
    accountId,
    qty: charge.qty,
    oneShot: charge.oneShot,
    amountCents: charge.amountCents,
    productName: charge.productName,
    customer
  });
  const created = await createPagarmePaymentLink(payload);
  if (!created.ok || !created.body?.url) {
    return {
      ok: false,
      error: created.body?.message || created.body?.error || 'Falha ao criar checkout na Pagar.me',
      status: created.status,
      body: created.body
    };
  }

  const title = payload.name;
  if (sbConfigured()) {
    try {
      await sbInsert('dlocal_checkout_intents', {
        account_id: String(accountId),
        email: customer.email,
        qty: charge.qty,
        amount_cents: charge.amountCents,
        title,
        checkout_url: created.body.url,
        status: 'pending',
        dlocal_payment_id: created.body.id,
        details: {
          provider: 'pagarme',
          kind: charge.oneShot ? 'one_shot' : 'subscription',
          keep_cycle: Boolean(charge.keepCycle),
          due_date: charge.dueDate,
          product_name: charge.productName
        }
      });
    } catch (err) {
      console.error('pagarme-assinatura: intent', err.message);
    }
  }

  return {
    ok: true,
    id: created.body.id,
    checkout_url: created.body.url,
    ...charge
  };
}

export async function findPagarmeAssinaturaIntent(paymentLinkId) {
  if (!sbConfigured() || !paymentLinkId) return null;
  const rows = await sbSelect('dlocal_checkout_intents', {
    eq: { dlocal_payment_id: String(paymentLinkId) },
    limit: 1
  });
  const row = rows[0];
  if (!row) return null;
  if (row.details?.provider && row.details.provider !== 'pagarme') return null;
  return row;
}

async function rememberEvent(eventId, accountId, details) {
  if (!eventId || !sbConfigured()) return false;
  try {
    await sbInsert('dlocal_processed_events', {
      event_id: String(eventId),
      account_id: accountId || null,
      action: 'pagarme_paid',
      details: details || {}
    });
    return false;
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('23505') || msg.toLowerCase().includes('duplicate')) return true;
    console.error('pagarme-assinatura: dedupe', err.message);
    return false;
  }
}

export async function processPagarmeAssinaturaPaid(paymentLinkId, {
  payload = {},
  req = null,
  source = 'webhook'
} = {}) {
  const intent = await findPagarmeAssinaturaIntent(paymentLinkId);
  if (!intent) {
    return { processed: false, error: 'intent Pagar.me não encontrada', payment_link_id: paymentLinkId };
  }

  const link = await getPagarmePaymentLink(paymentLinkId);
  if (!link.ok || !paymentLinkLooksPaid(link.body)) {
    return { processed: false, ignored: true, payment_link_id: paymentLinkId, status: link.body?.status || null };
  }

  const accountId = String(intent.account_id);
  const qty = Number(intent.qty);
  const oneShot = String(intent.details?.kind || '').toLowerCase() === 'one_shot';
  const eventId = `pagarme:${paymentLinkId}`;
  const already = await rememberEvent(eventId, accountId, { qty, source });
  if (already) {
    return { processed: false, duplicate: true, payment_link_id: paymentLinkId, account_id: accountId, qty };
  }

  const activated = await activateLeonaAndCancelLegacy({
    accountId,
    qty,
    dueDate: resolveDueDate(intent, oneShot),
    email: intent.email,
    reason: 'Pago via Pagar.me'
  });

  if (activated.ok && sbConfigured() && intent.id) {
    try {
      await sbUpdate('dlocal_checkout_intents', { id: intent.id }, {
        status: 'paid',
        paid_at: new Date().toISOString()
      });
    } catch (err) {
      console.error('pagarme-assinatura: mark intent', err.message);
    }
  }

  if (activated.ok && intent.email) {
    await notifyAffiliatesPagou({
      txId: eventId,
      email: intent.email,
      name: activated.profile?.user?.name || null,
      amountCents: Number(intent.amount_cents) || null,
      paidAt: new Date().toISOString(),
      status: 'approved'
    });
  }

  logAssinaturaEvent(req, {
    action: activated.ok ? 'pagarme_assinatura_paid' : 'pagarme_assinatura_failed',
    provider: 'pagarme',
    email: intent.email,
    account_id: accountId,
    details: {
      payment_link_id: paymentLinkId,
      qty,
      amount_cents: intent.amount_cents,
      kind: oneShot ? 'one_shot' : 'subscription',
      source,
      leona_ok: activated.ok,
      leona_error: activated.leona?.body?.error || activated.error || null
    }
  });

  return {
    processed: activated.ok,
    payment_link_id: paymentLinkId,
    account_id: accountId,
    qty,
    error: activated.ok ? null : (activated.leona?.body?.error || activated.error || 'falha ao atualizar Leona')
  };
}

function resolveDueDate(intent, oneShot) {
  if (oneShot && intent.details?.keep_cycle && intent.details?.due_date) {
    return String(intent.details.due_date).slice(0, 10);
  }
  const plus30 = dueDatePlusDays(30);
  if (!oneShot) return laterDate(plus30, intent.details?.due_date) || plus30;
  return plus30;
}

export async function reconcilePendingPagarmeAssinatura({ max = 20, payload = {}, req = null } = {}) {
  if (!sbConfigured()) return { processed: 0 };
  const rows = await sbSelect('dlocal_checkout_intents', {
    eq: { status: 'pending' },
    order: 'created_at.desc',
    limit: max
  });
  let processed = 0;
  for (const row of rows) {
    if (row.details?.provider !== 'pagarme' || !row.dlocal_payment_id) continue;
    const result = await processPagarmeAssinaturaPaid(row.dlocal_payment_id, {
      payload,
      req,
      source: 'reconcile'
    });
    if (result.processed) processed += 1;
  }
  return { processed };
}
