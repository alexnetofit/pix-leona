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
  createPagarmeOrder,
  extractPagarmePix,
  getPagarmeOrder,
  getPagarmePaymentLink,
  PAGARME_DIGITAL_ADDRESS,
  friendlyPagarmeError,
  pagarmeDeclineMessage,
  pagarmeDigitalCustomer,
  pagarmeOrderLooksPaid,
  parsePagarmeDocument
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

export function buildPagarmeAssinaturaOrderPayload({
  accountId,
  qty,
  oneShot,
  amountCents,
  productName,
  customer,
  method,
  cardToken,
  card
}) {
  const code = `leona-${accountId}-${qty}-${oneShot ? 'prorata' : 'sub'}`;
  const cardPay = method === 'card' || method === 'credit_card';
  const payments = cardPay
    ? [{
        payment_method: 'credit_card',
        credit_card: {
          installments: 1,
          statement_descriptor: 'LEONA FLOW',
          ...(cardToken
            ? { card_token: cardToken, card: { billing_address: PAGARME_DIGITAL_ADDRESS } }
            : {
                card: {
                  number: String(card?.number || '').replace(/\D/g, ''),
                  holder_name: String(card?.holder_name || customer?.name || 'Cliente Leona').slice(0, 64),
                  exp_month: Number(card?.exp_month),
                  exp_year: Number(card?.exp_year),
                  cvv: String(card?.cvv || '').replace(/\D/g, ''),
                  billing_address: PAGARME_DIGITAL_ADDRESS
                }
              })
        }
      }]
    : [{ payment_method: 'pix', pix: { expires_in: 3600 } }];
  return {
    closed: true,
    code,
    items: [{
      amount: amountCents,
      description: String(productName).slice(0, 64),
      quantity: 1,
      code
    }],
    customer: pagarmeDigitalCustomer(customer),
    payments,
    metadata: {
      account_id: String(accountId),
      qty: String(qty),
      kind: oneShot ? 'one_shot' : 'subscription'
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
  profile,
  method,
  cardToken,
  card,
  document
}) {
  const charge = resolvePagarmeAssinaturaCharge({ qty, kind, amount, profile });
  if (!charge.ok) return charge;

  const parsedDoc = parsePagarmeDocument(document || profile?.user?.document || profile?.user?.cpf);
  if (!parsedDoc) {
    return { ok: false, error: 'Informe um CPF ou CNPJ válido', status: 400 };
  }

  const customer = {
    name: String(name || profile?.user?.name || 'Cliente Leona').trim().slice(0, 64),
    email: String(email || profile?.user?.email || '').trim().toLowerCase(),
    document: parsedDoc.document
  };
  if (!customer.email || !customer.email.includes('@')) {
    return { ok: false, error: 'E-mail da conta Leona inválido' };
  }

  const cardPay = method === 'card' || method === 'credit_card';
  if (cardPay && !cardToken && !card?.number) {
    return { ok: false, error: 'Preencha os dados do cartão' };
  }

  const payload = buildPagarmeAssinaturaOrderPayload({
    accountId,
    qty: charge.qty,
    oneShot: charge.oneShot,
    amountCents: charge.amountCents,
    productName: charge.productName,
    customer,
    method: cardPay ? 'credit_card' : 'pix',
    cardToken,
    card
  });
  const created = await createPagarmeOrder(payload);
  if (!created.ok || !created.body?.id) {
    return {
      ok: false,
      error: friendlyPagarmeError(created.body?.message || created.body?.error) || 'Falha ao criar cobrança na Pagar.me',
      status: created.status,
      body: created.body
    };
  }

  const paid = pagarmeOrderLooksPaid(created.body);
  const failed = String(created.body.status || '').toLowerCase() === 'failed' && !paid;
  if (failed) {
    return {
      ok: false,
      error: pagarmeDeclineMessage(created.body) || 'Pagamento recusado',
      status: 402,
      body: created.body
    };
  }

  const title = String(charge.productName || payload.code).slice(0, 64);
  if (sbConfigured()) {
    try {
      await sbInsert('dlocal_checkout_intents', {
        account_id: String(accountId),
        email: customer.email,
        qty: charge.qty,
        amount_cents: charge.amountCents,
        title,
        checkout_url: `https://client.leonaflow.com/assinatura?pagarme=${created.body.id}`,
        status: 'pending',
        dlocal_payment_id: created.body.id,
        details: {
          provider: 'pagarme',
          kind: charge.oneShot ? 'one_shot' : 'subscription',
          keep_cycle: Boolean(charge.keepCycle),
          due_date: charge.dueDate,
          product_name: charge.productName,
          method: cardPay ? 'credit_card' : 'pix'
        }
      });
    } catch (err) {
      console.error('pagarme-assinatura: intent', err.message);
    }
  }

  if (paid) {
    await processPagarmeAssinaturaPaid(created.body.id, { source: 'api' });
  }

  return {
    ok: true,
    id: created.body.id,
    paid,
    pix: cardPay ? null : extractPagarmePix(created.body),
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

  const isOrder = /^or_/i.test(String(paymentLinkId));
  if (isOrder) {
    const order = await getPagarmeOrder(paymentLinkId);
    if (!order.ok || !pagarmeOrderLooksPaid(order.body)) {
      return { processed: false, ignored: true, payment_link_id: paymentLinkId, status: order.body?.status || null };
    }
  } else {
    const link = await getPagarmePaymentLink(paymentLinkId);
    if (!link.ok || !paymentLinkLooksPaid(link.body)) {
      return { processed: false, ignored: true, payment_link_id: paymentLinkId, status: link.body?.status || null };
    }
  }

  const accountId = String(intent.account_id);
  const qty = Number(intent.qty);
  const oneShot = String(intent.details?.kind || '').toLowerCase() === 'one_shot';
  const keepCycle = oneShot && Boolean(intent.details?.keep_cycle);
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
    reason: keepCycle ? 'Upgrade pró-rata via Pagar.me (ciclo mantido)' : 'Pago via Pagar.me',
    keepCycle
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
