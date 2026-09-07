/**
 * Checkout Pagar.me (Stone) da /assinatura — avulso (order).
 * Recorrência, se houver, é cobrada por nós no vencimento da Leona.
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
  createPagarmePaymentLink,
  extractPagarmeCycleKey,
  extractPagarmeOrderId,
  extractPagarmeSubscriptionId,
  findPagarmeCustomerByEmail,
  getPagarmeOrder,
  getPagarmeSubscription,
  refreshPagarmePix,
  getPagarmePaymentLink,
  listPagarmeSubscriptionsByCustomer,
  PAGARME_DIGITAL_ADDRESS,
  friendlyPagarmeError,
  pagarmeDeclineMessage,
  pagarmeDigitalCustomer,
  pagarmeOrderLooksPaid,
  parsePagarmeDocument,
  updatePagarmeSubscription,
  updatePagarmeSubscriptionItem
} from './pagarme.js';
import { assertPagarmeCardAllowed } from './pagarme-card-limits.js';
import {
  buildPagarmeDowngradeItemPayload,
  pickActivePagarmeLeonaSub,
  pickPagarmeSubscriptionItem
} from './pagarme-downgrade.js';
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

export function assinaturaReturnUrl({ accountId, email, publicUrl } = {}) {
  const configured = String(publicUrl || process.env.ASSINATURA_PUBLIC_URL || 'https://client.leonaflow.com/assinatura').replace(/\/+$/, '');
  const origin = configured.replace(/\/assinatura$/i, '') || 'https://client.leonaflow.com';
  const qs = new URLSearchParams();
  if (accountId) qs.set('account_id', String(accountId));
  if (email) qs.set('email', String(email));
  qs.set('paid', '1');
  return `${origin}/assinatura?${qs}`;
}

export function pagarmeAssinaturaLinkCustomer({ name, email, document } = {}) {
  const parsed = parsePagarmeDocument(document);
  return {
    name: String(name || 'Cliente Leona').trim().slice(0, 64) || 'Cliente Leona',
    email: String(email || '').trim().toLowerCase(),
    type: parsed?.type || 'individual',
    ...(parsed ? { document: parsed.document, document_type: parsed.document_type } : {})
  };
}

export function buildPagarmeAssinaturaPaymentLinkPayload({
  accountId,
  qty,
  oneShot,
  amountCents,
  productName,
  customer,
  successUrl
} = {}) {
  const code = `leona-${accountId}-${qty}-${oneShot ? 'prorata' : 'sub'}`;
  return {
    type: 'order',
    name: String(productName || `Leona ${accountId}`).slice(0, 64),
    max_paid_sessions: 1,
    expires_in: 180,
    payment_settings: {
      accepted_payment_methods: ['credit_card'],
      credit_card_settings: {
        operation_type: 'auth_and_capture',
        installments: [{ number: 1, total: amountCents }]
      }
    },
    customer_settings: {
      customer: pagarmeAssinaturaLinkCustomer(customer)
    },
    cart_settings: {
      items: [{
        name: String(productName || code).slice(0, 64),
        amount: amountCents,
        default_quantity: 1,
        description: code
      }]
    },
    flow_settings: {
      success_url: successUrl
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
  const title = String(charge.productName || `Leona ${accountId}`).slice(0, 64);

  if (cardPay) {
    const limit = await assertPagarmeCardAllowed(customer.email);
    if (!limit.ok) return limit;

    const reused = await findReusableAssinaturaCardLink({
      accountId,
      amountCents: charge.amountCents
    });
    if (reused) {
      return {
        ok: true,
        id: reused.id,
        url: reused.url,
        checkout_url: reused.url,
        paid: false,
        pix: null,
        ...charge
      };
    }

    const payload = buildPagarmeAssinaturaPaymentLinkPayload({
      accountId,
      qty: charge.qty,
      oneShot: charge.oneShot,
      amountCents: charge.amountCents,
      productName: charge.productName,
      customer,
      successUrl: assinaturaReturnUrl({ accountId, email: customer.email })
    });
    const created = await createPagarmePaymentLink(payload);
    if (!created.ok || !created.body?.url) {
      return {
        ok: false,
        error: friendlyPagarmeError(created.body?.message || created.body?.error) || 'Falha ao criar checkout na Pagar.me',
        status: created.status,
        body: created.body
      };
    }
    await saveAssinaturaIntent({
      accountId,
      email: customer.email,
      qty: charge.qty,
      amountCents: charge.amountCents,
      title,
      paymentId: created.body.id,
      checkoutUrl: created.body.url,
      charge,
      method: 'credit_card'
    });
    return {
      ok: true,
      id: created.body.id,
      url: created.body.url,
      checkout_url: created.body.url,
      paid: false,
      pix: null,
      ...charge
    };
  }

  const payload = buildPagarmeAssinaturaOrderPayload({
    accountId,
    qty: charge.qty,
    oneShot: charge.oneShot,
    amountCents: charge.amountCents,
    productName: charge.productName,
    customer,
    method: 'pix',
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

  await saveAssinaturaIntent({
    accountId,
    email: customer.email,
    qty: charge.qty,
    amountCents: charge.amountCents,
    title,
    paymentId: created.body.id,
    checkoutUrl: `https://client.leonaflow.com/assinatura?pagarme=${created.body.id}`,
    charge,
    method: 'pix'
  });

  if (paid) {
    await processPagarmeAssinaturaPaid(created.body.id, { source: 'api' });
  }

  return {
    ok: true,
    id: created.body.id,
    paid,
    pix: await refreshPagarmePix(created.body),
    ...charge
  };
}

async function saveAssinaturaIntent({
  accountId,
  email,
  qty,
  amountCents,
  title,
  paymentId,
  checkoutUrl,
  charge,
  method
}) {
  if (!sbConfigured()) return;
  try {
    await sbInsert('dlocal_checkout_intents', {
      account_id: String(accountId),
      email,
      qty,
      amount_cents: amountCents,
      title,
      checkout_url: checkoutUrl,
      status: 'pending',
      dlocal_payment_id: paymentId,
      details: {
        provider: 'pagarme',
        kind: charge.oneShot ? 'one_shot' : 'subscription',
        keep_cycle: Boolean(charge.keepCycle),
        due_date: charge.dueDate,
        product_name: charge.productName,
        method,
        link_type: 'order'
      }
    });
  } catch (err) {
    console.error('pagarme-assinatura: intent', err.message);
  }
}

async function findReusableAssinaturaCardLink({ accountId, amountCents }) {
  if (!sbConfigured() || !accountId) return null;
  const rows = await sbSelect('dlocal_checkout_intents', {
    eq: { account_id: String(accountId), status: 'pending' },
    order: 'created_at.desc',
    limit: 8
  });
  const since = Date.now() - 6 * 60 * 60 * 1000;
  for (const row of rows) {
    if (row.details?.provider !== 'pagarme') continue;
    if (row.details?.method !== 'credit_card') continue;
    if (Number(row.amount_cents) !== Number(amountCents)) continue;
    if (!/^pl_/i.test(String(row.dlocal_payment_id || ''))) continue;
    if (row.details?.link_type === 'subscription') continue;
    if (Date.parse(row.created_at || '') < since) continue;
    const link = await getPagarmePaymentLink(row.dlocal_payment_id);
    if (!link.ok || paymentLinkLooksPaid(link.body)) continue;
    const status = String(link.body?.status || '').toLowerCase();
    if (['canceled', 'cancelled', 'expired', 'inactive', 'finished'].includes(status)) continue;
    if (!link.body?.url) continue;
    return { id: row.dlocal_payment_id, url: link.body.url };
  }
  return null;
}

export function assinaturaCheckoutLooksPaid({ order = null, link = null } = {}) {
  if (order && pagarmeOrderLooksPaid(order)) return true;
  if (link && paymentLinkLooksPaid(link)) return true;
  return false;
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

async function loadAssinaturaPaidProof(paymentId, payload = {}) {
  const orderId = extractPagarmeOrderId(payload)
    || (/^or_/i.test(String(paymentId)) ? String(paymentId) : null);
  let order = null;
  if (orderId) {
    const found = await getPagarmeOrder(orderId);
    if (found.ok) order = found.body;
  }
  let link = null;
  if (/^pl_/i.test(String(paymentId))) {
    const found = await getPagarmePaymentLink(paymentId);
    if (found.ok) link = found.body;
  }
  return {
    paid: assinaturaCheckoutLooksPaid({ order, link }),
    order,
    link,
    orderId,
    status: order?.status || link?.status || null
  };
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

  const proof = await loadAssinaturaPaidProof(paymentLinkId, payload);
  if (!proof.paid) {
    return { processed: false, ignored: true, payment_link_id: paymentLinkId, status: proof.status };
  }

  const accountId = String(intent.account_id);
  const qty = Number(intent.qty);
  const oneShot = String(intent.details?.kind || '').toLowerCase() === 'one_shot';
  const eventId = `pagarme:${paymentLinkId}`;
  const already = await rememberEvent(eventId, accountId, { qty, source });
  if (already && String(intent.status || '') === 'paid') {
    return { processed: false, duplicate: true, payment_link_id: paymentLinkId, account_id: accountId, qty };
  }

  let subscription = null;
  try {
    subscription = await attachPagarmeSubscription({
      intent,
      payload,
      paymentLinkId
    });
  } catch (err) {
    console.error('pagarme-assinatura: attach sub', err.message);
  }
  if (subscription?.id) {
    const cycleKey = extractPagarmeCycleKey(payload, subscription) || 'first';
    await rememberEvent(`pagarme:sub:${subscription.id}:${cycleKey}`, accountId, {
      qty,
      source,
      payment_link_id: paymentLinkId
    });
  }

  const activated = await activateLeonaAndCancelLegacy({
    accountId,
    qty,
    dueDate: resolveDueDate(intent, oneShot, subscription),
    email: intent.email,
    reason: 'Pago via Pagar.me'
  });

  if (activated.ok && sbConfigured() && intent.id) {
    try {
      await sbUpdate('dlocal_checkout_intents', { id: intent.id }, {
        status: 'paid',
        paid_at: new Date().toISOString(),
        details: {
          ...(intent.details || {}),
          subscription_id: subscription?.id || intent.details?.subscription_id || null,
          order_id: proof.orderId || proof.order?.id || intent.details?.order_id || null
        }
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
      subscription_id: subscription?.id || null,
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
    subscription_id: subscription?.id || null,
    account_id: accountId,
    qty,
    error: activated.ok ? null : (activated.leona?.body?.error || activated.error || 'falha ao atualizar Leona')
  };
}

function resolveDueDate(intent, oneShot, subscription) {
  if (oneShot && intent.details?.keep_cycle && intent.details?.due_date) {
    return String(intent.details.due_date).slice(0, 10);
  }
  const fromSub = subscriptionDueDate(subscription);
  const plus30 = dueDatePlusDays(30);
  if (fromSub) return laterDate(plus30, fromSub) || plus30;
  if (!oneShot) return laterDate(plus30, intent.details?.due_date) || plus30;
  return plus30;
}

export function subscriptionDueDate(subscription) {
  const raw = subscription?.current_cycle?.end_at
    || subscription?.next_billing_at
    || null;
  return raw ? String(raw).slice(0, 10) : null;
}

export function inferQtyFromPagarmeSubscription(sub) {
  const metaQty = Number(sub?.metadata?.qty);
  if (Number.isFinite(metaQty) && metaQty >= 1) return metaQty;
  const text = [
    sub?.plan?.name,
    sub?.plan?.description,
    ...(Array.isArray(sub?.items) ? sub.items.map((item) => item?.name || item?.description || '') : [])
  ].join(' ');
  const match = text.match(/(\d+)\s*conex/i) || String(sub?.code || '').match(/leona-[^:]+:?(\d+)/i);
  if (match) return Number(match[1]);
  return 1;
}

async function attachPagarmeSubscription({ intent, payload, paymentLinkId }) {
  let subscriptionId = extractPagarmeSubscriptionId(payload);
  if (!subscriptionId && /^pl_/i.test(String(paymentLinkId || ''))) {
    const link = await getPagarmePaymentLink(paymentLinkId);
    if (link.ok) subscriptionId = extractPagarmeSubscriptionId(link.body);
  }

  const email = String(intent.email || '').trim().toLowerCase();
  const customer = email ? await findPagarmeCustomerByEmail(email) : null;
  const subs = customer?.id
    ? await listPagarmeSubscriptionsByCustomer(customer.id, { size: 30 })
    : [];
  if (!subscriptionId) {
    subscriptionId = pickActivePagarmeLeonaSub(subs)?.id || null;
  }

  const oneShot = String(intent.details?.kind || '').toLowerCase() === 'one_shot';
  const qty = Number(intent.qty);
  let subscription = null;

  if (subscriptionId) {
    const fetched = await getPagarmeSubscription(subscriptionId);
    subscription = fetched.ok ? fetched.body : { id: subscriptionId };
    await stampPagarmeSubscription(subscription, intent);
    if (oneShot) {
      await syncPagarmeSubscriptionQty(subscription, qty);
    }
    return subscription;
  }

  return subscription;
}

async function stampPagarmeSubscription(subscription, intent) {
  if (!subscription?.id) return;
  const qty = Number(intent.qty);
  try {
    await updatePagarmeSubscription(subscription.id, {
      code: `leona-${intent.account_id}-${qty}`.slice(0, 52),
      metadata: {
        ...(subscription.metadata || {}),
        account_id: String(intent.account_id),
        qty: String(qty),
        email: String(intent.email || '')
      }
    });
  } catch (err) {
    console.error('pagarme-assinatura: stamp sub', err.message);
  }
}

async function syncPagarmeSubscriptionQty(subscription, qty) {
  if (!subscription?.id) return { ok: false };
  let sub = subscription;
  if (!pickPagarmeSubscriptionItem(sub)) {
    const fetched = await getPagarmeSubscription(sub.id);
    if (fetched.ok) sub = fetched.body;
  }
  const item = pickPagarmeSubscriptionItem(sub);
  if (!item?.id) return { ok: false };
  return updatePagarmeSubscriptionItem(sub.id, item.id, buildPagarmeDowngradeItemPayload(qty));
}

async function findPagarmeAssinaturaIntentBySubscription(subscriptionId) {
  if (!sbConfigured() || !subscriptionId) return null;
  const rows = await sbSelect('dlocal_checkout_intents', {
    order: 'created_at.desc',
    limit: 80
  });
  return rows.find((row) => (
    row.details?.provider === 'pagarme'
    && String(row.details?.subscription_id || '') === String(subscriptionId)
  )) || null;
}

async function resolveAccountFromSubscription(subscription) {
  const meta = subscription?.metadata || {};
  if (meta.account_id) {
    return {
      accountId: String(meta.account_id),
      qty: inferQtyFromPagarmeSubscription(subscription),
      email: String(meta.email || subscription.customer?.email || '').toLowerCase() || null
    };
  }
  const bySub = await findPagarmeAssinaturaIntentBySubscription(subscription?.id);
  if (bySub) {
    return {
      accountId: String(bySub.account_id),
      qty: Number(meta.qty || bySub.qty) || inferQtyFromPagarmeSubscription(subscription),
      email: bySub.email
    };
  }
  const email = String(subscription?.customer?.email || '').trim().toLowerCase();
  if (!email || !sbConfigured()) return null;
  const rows = await sbSelect('dlocal_checkout_intents', {
    eq: { email },
    order: 'created_at.desc',
    limit: 20
  });
  const row = rows.find((item) => item.details?.provider === 'pagarme');
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    qty: Number(meta.qty || row.qty) || inferQtyFromPagarmeSubscription(subscription),
    email
  };
}

export async function processPagarmeSubscriptionRenewal(subscriptionId, {
  payload = {},
  req = null,
  source = 'webhook'
} = {}) {
  if (!subscriptionId) {
    return { processed: false, error: 'subscription_id ausente' };
  }
  const fetched = await getPagarmeSubscription(subscriptionId);
  if (!fetched.ok || !fetched.body?.id) {
    return { processed: false, ignored: true, subscription_id: subscriptionId, status: fetched.status };
  }
  const subscription = fetched.body;
  const resolved = await resolveAccountFromSubscription(subscription);
  if (!resolved?.accountId) {
    return { processed: false, error: 'conta Leona não encontrada para a assinatura', subscription_id: subscriptionId };
  }

  const qty = Number(resolved.qty) || 1;
  const cycleKey = extractPagarmeCycleKey(payload, subscription) || 'renewal';
  const eventId = `pagarme:sub:${subscription.id}:${cycleKey}`;
  const already = await rememberEvent(eventId, resolved.accountId, { qty, source });
  if (already) {
    return {
      processed: false,
      duplicate: true,
      subscription_id: subscription.id,
      account_id: resolved.accountId,
      qty
    };
  }

  const dueDate = subscriptionDueDate(subscription) || dueDatePlusDays(30);
  const activated = await activateLeonaAndCancelLegacy({
    accountId: resolved.accountId,
    qty,
    dueDate,
    email: resolved.email,
    reason: 'Renovação Pagar.me'
  });

  if (activated.ok && !subscription.metadata?.account_id) {
    await stampPagarmeSubscription(subscription, {
      account_id: resolved.accountId,
      qty,
      email: resolved.email
    });
  }

  logAssinaturaEvent(req, {
    action: activated.ok ? 'pagarme_assinatura_renewed' : 'pagarme_assinatura_failed',
    provider: 'pagarme',
    email: resolved.email,
    account_id: resolved.accountId,
    details: {
      subscription_id: subscription.id,
      qty,
      due_date: dueDate,
      source,
      leona_ok: activated.ok,
      leona_error: activated.leona?.body?.error || activated.error || null
    }
  });

  return {
    processed: activated.ok,
    subscription_id: subscription.id,
    account_id: resolved.accountId,
    qty,
    error: activated.ok ? null : (activated.leona?.body?.error || activated.error || 'falha ao renovar Leona')
  };
}

export async function reconcilePendingPagarmeAssinatura({
  max = 20,
  payload = {},
  req = null,
  accountId = null
} = {}) {
  if (!sbConfigured()) return { processed: 0 };
  const query = {
    eq: { status: 'pending' },
    order: 'created_at.desc',
    limit: max
  };
  if (accountId) query.eq.account_id = String(accountId);
  const rows = await sbSelect('dlocal_checkout_intents', query);
  let processed = 0;
  for (const row of rows) {
    if (row.details?.provider !== 'pagarme' || !row.dlocal_payment_id) continue;
    const result = await processPagarmeAssinaturaPaid(row.dlocal_payment_id, {
      payload,
      req,
      source: accountId ? 'return' : 'reconcile'
    });
    if (result.processed) processed += 1;
  }
  return { processed };
}
