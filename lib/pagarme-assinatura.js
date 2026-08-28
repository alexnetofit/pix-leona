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
import { isCardMethod, isOneShotKind } from './dlocal-go.js';
import { notifyAffiliatesPagou } from './notify-affiliates.js';
import {
  createPagarmeOrder,
  createPagarmeSubscription,
  extractPagarmePix,
  getPagarmeOrder,
  getPagarmePaymentLink,
  getPagarmeSubscription,
  PAGARME_DIGITAL_ADDRESS,
  friendlyPagarmeError,
  pagarmeDeclineMessage,
  pagarmeDigitalCustomer,
  pagarmeOrderLooksPaid,
  pagarmeSubscriptionActive,
  pagarmeSubscriptionDeclineMessage,
  pagarmeSubscriptionMainItem,
  parsePagarmeDocument,
  updatePagarmeSubscriptionItem
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

function productLabel(qtyN, prefix) {
  return `${prefix} — ${qtyN} conex${qtyN === 1 ? 'ão' : 'ões'}`;
}

/**
 * Decide como cobrar a /assinatura na Pagar.me.
 *
 * Modos possíveis:
 *   - `subscription`: cartão + ciclo novo (sem sub Pagar.me ativa) → assinatura
 *     nativa mensal prepaid (POST /subscriptions).
 *   - `sub_update`: cartão + já existe sub_ Pagar.me ativa → atualiza o item
 *     mensal e cobra só o pró-rata do ajuste (pedido avulso).
 *   - `one_shot`: upgrade/ajuste avulso (inclui migração de outra plataforma) →
 *     pedido avulso, pró-rata quando há ciclo aberto com mudança de qty.
 *   - `order`: pedido avulso do mês cheio (PIX, ou cartão sem recorrência).
 *
 * PIX nunca vira recorrência — sempre pedido avulso.
 */
export function resolvePagarmeAssinaturaCharge({
  qty,
  kind,
  amount,
  profile,
  method = 'pix',
  hasActivePagarmeSub = false,
  now = new Date()
} = {}) {
  const qtyN = Math.max(1, Number(qty) || 0);
  if (!qtyN) return { ok: false, error: 'qty obrigatória' };

  const cardPay = isCardMethod(method);
  const oneShot = isOneShotKind(kind);
  const fullCents = leonaAmountCents(qtyN);
  const currentQty = Number(profile?.starter_instances || 0);
  const currentEnd = profile?.current_period_end || null;
  const cycleOpen = Boolean(currentEnd && new Date(currentEnd) > now);
  const qtyChanged = currentQty > 0 && qtyN !== currentQty;

  // Já assinante nativo Pagar.me no cartão, mexendo no mesmo plano: nada a cobrar.
  if (cardPay && !oneShot && hasActivePagarmeSub && !qtyChanged) {
    return { ok: false, error: 'Assinatura Pagar.me já ativa nesse plano', status: 409 };
  }

  // Pró-rata: upgrade avulso mid-ciclo OU ajuste de assinatura Pagar.me já ativa.
  const subUpdate = cardPay && hasActivePagarmeSub;
  if ((oneShot || subUpdate) && cycleOpen && qtyChanged) {
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
      mode: subUpdate ? 'sub_update' : 'one_shot',
      qty: qtyN,
      oneShot: true,
      amountCents,
      keepCycle: true,
      dueDate: String(currentEnd).slice(0, 10),
      productName: productLabel(qtyN, 'Ajuste Leona'),
      prorata: calc
    };
  }

  // Ciclo novo no cartão, sem sub Pagar.me ativa → assinatura nativa mensal.
  if (cardPay && !oneShot && !hasActivePagarmeSub) {
    return {
      ok: true,
      mode: 'subscription',
      qty: qtyN,
      oneShot: false,
      amountCents: fullCents,
      keepCycle: false,
      dueDate: null,
      productName: productLabel(qtyN, 'Leona Flow')
    };
  }

  // Demais casos: pedido avulso (PIX sempre; cartão one_shot sem ciclo aberto; etc).
  const customCents = reaisToCents(amount);
  const amountCents = oneShot && customCents ? customCents : fullCents;
  if (!amountCents || amountCents <= 0) {
    return { ok: false, error: 'amount obrigatório no ajuste proporcional' };
  }
  return {
    ok: true,
    mode: 'order',
    qty: qtyN,
    oneShot,
    amountCents,
    keepCycle: false,
    dueDate: null,
    productName: productLabel(qtyN, oneShot ? 'Ajuste Leona' : 'Leona Flow')
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

function pagarmeCardBlock({ customer, cardToken, card }) {
  if (cardToken) {
    return { card_token: cardToken, card: { billing_address: PAGARME_DIGITAL_ADDRESS } };
  }
  return {
    card: {
      number: String(card?.number || '').replace(/\D/g, ''),
      holder_name: String(card?.holder_name || customer?.name || 'Cliente Leona').slice(0, 64),
      exp_month: Number(card?.exp_month),
      exp_year: Number(card?.exp_year),
      cvv: String(card?.cvv || '').replace(/\D/g, ''),
      billing_address: PAGARME_DIGITAL_ADDRESS
    }
  };
}

/**
 * Assinatura nativa da Pagar.me (cartão, mensal, prepaid). O item mensal usa
 * pricing_scheme unitário com o valor do plano em centavos; a recorrência da
 * Pagar.me cobra sozinha os próximos ciclos e dispara `invoice.paid`.
 */
export function buildPagarmeSubscriptionPayload({
  accountId,
  qty,
  amountCents,
  productName,
  customer,
  cardToken,
  card
}) {
  const code = `leona-${accountId}-${qty}-sub`;
  return {
    code,
    payment_method: 'credit_card',
    interval: 'month',
    interval_count: 1,
    billing_type: 'prepaid',
    installments: 1,
    currency: 'BRL',
    statement_descriptor: 'LEONA FLOW',
    customer: pagarmeDigitalCustomer(customer),
    ...pagarmeCardBlock({ customer, cardToken, card }),
    items: [{
      description: String(productName).slice(0, 64),
      quantity: 1,
      pricing_scheme: { scheme_type: 'unit', price: amountCents }
    }],
    metadata: {
      account_id: String(accountId),
      qty: String(qty),
      kind: 'subscription'
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
  const cardPay = isCardMethod(method);

  const activeSub = cardPay ? await findActivePagarmeSubscription(accountId) : null;
  const charge = resolvePagarmeAssinaturaCharge({
    qty,
    kind,
    amount,
    profile,
    method: cardPay ? 'credit_card' : 'pix',
    hasActivePagarmeSub: Boolean(activeSub)
  });
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

  if (cardPay && !cardToken && !card?.number) {
    return { ok: false, error: 'Preencha os dados do cartão' };
  }

  if (charge.mode === 'subscription') {
    return createPagarmeNativeSubscription({ accountId, charge, customer, cardToken, card });
  }

  if (charge.mode === 'sub_update') {
    return updatePagarmeSubscriptionAndChargeProrata({
      accountId,
      charge,
      customer,
      cardToken,
      card,
      activeSub
    });
  }

  return createPagarmeAssinaturaOrder({ accountId, charge, customer, cardPay, cardToken, card });
}

async function createPagarmeAssinaturaOrder({ accountId, charge, customer, cardPay, cardToken, card }) {
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

  await savePagarmeAssinaturaIntent({
    accountId,
    paymentId: created.body.id,
    charge,
    customer,
    method: cardPay ? 'credit_card' : 'pix'
  });

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

async function createPagarmeNativeSubscription({ accountId, charge, customer, cardToken, card }) {
  const payload = buildPagarmeSubscriptionPayload({
    accountId,
    qty: charge.qty,
    amountCents: charge.amountCents,
    productName: charge.productName,
    customer,
    cardToken,
    card
  });
  const created = await createPagarmeSubscription(payload);
  const sub = created.body || {};
  if (!created.ok || !sub.id) {
    return {
      ok: false,
      error: friendlyPagarmeError(sub.message || sub.error) || 'Falha ao criar assinatura na Pagar.me',
      status: created.status,
      body: sub
    };
  }
  if (!pagarmeSubscriptionActive(sub)) {
    return {
      ok: false,
      error: pagarmeSubscriptionDeclineMessage(sub) || 'Pagamento recusado',
      status: 402,
      body: sub
    };
  }

  await savePagarmeAssinaturaIntent({
    accountId,
    paymentId: sub.id,
    charge,
    customer,
    method: 'credit_card',
    subscription: true
  });

  // Prepaid: o 1º ciclo é cobrado na criação — libera a Leona já com o cycle atual.
  const cycleId = sub.current_cycle?.id || sub.id;
  const cycle = await processPagarmeSubscriptionInvoicePaid({
    subscriptionId: sub.id,
    cycleId,
    source: 'api'
  });

  return {
    ok: true,
    id: sub.id,
    subscription: true,
    paid: Boolean(cycle.processed),
    pix: null,
    ...charge
  };
}

async function updatePagarmeSubscriptionAndChargeProrata({
  accountId,
  charge,
  customer,
  cardToken,
  card,
  activeSub
}) {
  // 1) Atualiza o item mensal — os próximos ciclos passam a cobrar o novo plano.
  const item = pagarmeSubscriptionMainItem(activeSub.subscription);
  if (item?.id) {
    const updated = await updatePagarmeSubscriptionItem(activeSub.id, item.id, {
      description: productLabel(charge.qty, 'Leona Flow').slice(0, 64),
      quantity: 1,
      pricing_scheme: { scheme_type: 'unit', price: leonaAmountCents(charge.qty) }
    });
    if (!updated.ok) {
      return {
        ok: false,
        error: friendlyPagarmeError(updated.body?.message || updated.body?.error) || 'Falha ao atualizar a assinatura Pagar.me',
        status: updated.status,
        body: updated.body
      };
    }
  }

  // Mantém a qty da assinatura em dia pros ciclos futuros do webhook invoice.paid.
  if (sbConfigured() && activeSub.intent?.id) {
    try {
      await sbUpdate('dlocal_checkout_intents', { id: activeSub.intent.id }, {
        qty: charge.qty,
        details: {
          ...(activeSub.intent.details || {}),
          qty: charge.qty,
          subscription: true,
          provider: 'pagarme',
          kind: 'subscription'
        }
      });
    } catch (err) {
      console.error('pagarme-assinatura: sub item qty', err.message);
    }
  }

  // 2) Cobra só o pró-rata do ajuste agora (pedido avulso, cartão à vista).
  const order = await createPagarmeAssinaturaOrder({
    accountId,
    charge,
    customer,
    cardPay: true,
    cardToken,
    card
  });
  return { ...order, subscription_id: activeSub.id, mode: 'sub_update' };
}

async function savePagarmeAssinaturaIntent({
  accountId,
  paymentId,
  charge,
  customer,
  method,
  subscription = false
}) {
  if (!sbConfigured()) return;
  const title = String(charge.productName || `leona-${accountId}-${charge.qty}`).slice(0, 64);
  try {
    await sbInsert('dlocal_checkout_intents', {
      account_id: String(accountId),
      email: customer.email,
      qty: charge.qty,
      amount_cents: charge.amountCents,
      title,
      checkout_url: `https://client.leonaflow.com/assinatura?pagarme=${paymentId}`,
      status: 'pending',
      dlocal_payment_id: paymentId,
      details: {
        provider: 'pagarme',
        kind: subscription ? 'subscription' : (charge.oneShot ? 'one_shot' : 'subscription'),
        subscription,
        keep_cycle: Boolean(charge.keepCycle),
        due_date: charge.dueDate,
        product_name: charge.productName,
        method
      }
    });
  } catch (err) {
    console.error('pagarme-assinatura: intent', err.message);
  }
}

/**
 * Acha a assinatura nativa Pagar.me ativa de uma conta (intent com `sub_...`),
 * confirmando o status na API. Retorna null se não houver ou já cancelada.
 */
export async function findActivePagarmeSubscription(accountId) {
  if (!sbConfigured() || !accountId) return null;
  let rows = [];
  try {
    rows = await sbSelect('dlocal_checkout_intents', {
      eq: { account_id: String(accountId) },
      order: 'created_at.desc',
      limit: 20
    });
  } catch (err) {
    console.error('pagarme-assinatura: busca sub', err.message);
    return null;
  }
  const candidates = rows.filter((row) =>
    row.details?.provider === 'pagarme'
    && row.details?.subscription === true
    && /^sub_/i.test(String(row.dlocal_payment_id || ''))
    && String(row.status || '') !== 'canceled'
  );
  for (const row of candidates) {
    const sub = await getPagarmeSubscription(row.dlocal_payment_id);
    if (sub.ok && pagarmeSubscriptionActive(sub.body)) {
      return { intent: row, subscription: sub.body, id: row.dlocal_payment_id };
    }
  }
  return null;
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

/**
 * Libera a Leona a cada ciclo pago de uma assinatura nativa Pagar.me.
 * Dedup por `pagarme:sub_…:cycle_…`, então cada `invoice.paid` do mesmo ciclo
 * roda uma única vez.
 */
export async function processPagarmeSubscriptionInvoicePaid({
  subscriptionId,
  cycleId,
  cycleEnd = null,
  req = null,
  source = 'webhook'
} = {}) {
  const subId = String(subscriptionId || '').trim();
  if (!subId) return { processed: false, error: 'subscription_id ausente' };

  const intent = await findPagarmeAssinaturaIntent(subId);
  if (!intent) {
    return { processed: false, error: 'assinatura Pagar.me não encontrada', subscription_id: subId };
  }

  const accountId = String(intent.account_id);
  const qty = Number(intent.qty);
  const cycle = String(cycleId || '').trim() || `cycle-${dueDatePlusDays(0)}`;
  const eventId = `pagarme:${subId}:${cycle}`;
  const already = await rememberEvent(eventId, accountId, { qty, source, cycle });
  if (already) {
    return { processed: false, duplicate: true, subscription_id: subId, cycle, account_id: accountId, qty };
  }

  const dueDate = cycleEnd ? String(cycleEnd).slice(0, 10) : dueDatePlusDays(30);
  const activated = await activateLeonaAndCancelLegacy({
    accountId,
    qty,
    dueDate,
    email: intent.email,
    reason: 'Ciclo pago via Pagar.me (assinatura)'
  });

  if (activated.ok && sbConfigured() && intent.id) {
    try {
      await sbUpdate('dlocal_checkout_intents', { id: intent.id }, {
        status: 'paid',
        paid_at: new Date().toISOString(),
        details: { ...(intent.details || {}), last_cycle: cycle }
      });
    } catch (err) {
      console.error('pagarme-assinatura: mark sub cycle', err.message);
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
      subscription_id: subId,
      cycle,
      qty,
      amount_cents: intent.amount_cents,
      kind: 'subscription',
      source,
      leona_ok: activated.ok,
      leona_error: activated.leona?.body?.error || activated.error || null
    }
  });

  return {
    processed: activated.ok,
    subscription_id: subId,
    cycle,
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
