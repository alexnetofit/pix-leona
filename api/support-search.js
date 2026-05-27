/**
 * api/support-search.js — Busca de cliente pelo time de suporte.
 *
 * Difere de /api/guru-search por:
 *   - Auth de suporte (SUPPORT_CHAT_TOKEN via Bearer)
 *   - Aceita email LIVRE, sem regra anti-IDOR (suporte legitimamente busca
 *     por cliente alheio — exatamente o ponto da pagina /suporte)
 *   - Retorna leona + guru subs + transacoes/faturas dos ultimos 60 dias
 *     (parametrizavel via ?days=N)
 *
 * Body: { email: string, days?: number }
 * Resposta: { leona: {...}, guru: { contact, subscriptions, invoices } }
 *
 * Usado por public/suporte.html.
 */

import { applyCors, requireSupport, enforceAuth } from '../lib/auth.js';
import { LEONA_BASE, leonaHeaders } from '../lib/leona.js';
import {
  GURU_BASE,
  LEONA_GURU_PRODUCT_ID,
  guruHeaders,
  findGuruContactByEmail
} from '../lib/guru.js';

const DEFAULT_DAYS = 60;
const MAX_DAYS = 365;

function tsToIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function daysAgoYmd(days) {
  const dt = new Date(Date.now() - days * 86400 * 1000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseToMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  const ms = new Date(String(value).slice(0, 10)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Fatura entra na janela se charge_at, periodo ou confirmacao >= sinceMs. */
function isWithinLookback(tx, sinceMs) {
  const candidates = [
    tx.invoice?.charge_at,
    tx.invoice?.period_start,
    tx.confirmed_at,
    tx.ordered_at
  ];
  return candidates.some(v => {
    const ms = parseToMs(v);
    return ms != null && ms >= sinceMs;
  });
}

function mapTransactionToInvoice(t) {
  return {
    transaction_id: t.id,
    transaction_code: t.transaction_code || null,
    transaction_status: t.status || null,
    invoice_id: t.invoice?.id || null,
    invoice_status: t.invoice?.status || null,
    value: t.invoice?.value ?? t.value ?? null,
    currency: t.currency || 'BRL',
    cycle: t.invoice?.cycle ?? null,
    type: t.invoice?.type || null,
    ordered_at: tsToIso(t.ordered_at),
    confirmed_at: tsToIso(t.confirmed_at),
    charge_at: t.invoice?.charge_at || null,
    period_start: t.invoice?.period_start || null,
    period_end: t.invoice?.period_end || null,
    payment_method: t.payment?.method || null,
    payment_url: t.invoice?.payment_url || t.payment?.url || null,
    offer_id: t.product?.offer?.id || null,
    offer_name: t.product?.offer?.name || null,
    subscription_id: t.subscription?.internal_id || null,
    subscription_code: t.subscription?.code || null,
    refundable: t.status === 'approved'
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const auth = requireSupport(req);
  if (enforceAuth(req, res, auth, { route: '/api/support-search' })) return;

  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { email, days } = req.body || {};
  const emailClean = email ? String(email).trim().toLowerCase() : '';
  if (!emailClean) return res.status(400).json({ error: 'email é obrigatório' });

  const lookbackDays = Math.min(MAX_DAYS, Math.max(1, Number(days) || DEFAULT_DAYS));
  const sinceYmd = daysAgoYmd(lookbackDays);
  const sinceMs = new Date(`${sinceYmd}T00:00:00Z`).getTime();

  try {
    const headers = guruHeaders(guruToken);

    // Lookup paralelo: contato Guru + billing Leona (caso haja)
    const [contact, leonaProfilesRaw] = await Promise.all([
      findGuruContactByEmail(emailClean, guruToken),
      leonaToken
        ? fetch(`${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(emailClean)}`, {
            headers: leonaHeaders(leonaToken)
          }).then(async r => {
            if (r.ok) return [await r.json()];
            // 409 = email com multiplas contas Leona
            if (r.status === 409) {
              const conflict = await r.json().catch(() => ({}));
              const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
              if (ids.length === 0) return [];
              const profiles = await Promise.all(ids.map(async id => {
                try {
                  const pr = await fetch(`${LEONA_BASE}/accounts/${id}/billing_profile`, {
                    headers: leonaHeaders(leonaToken)
                  });
                  if (pr.ok) return await pr.json();
                } catch (_) {}
                return null;
              }));
              return profiles.filter(Boolean);
            }
            return [];
          }).catch(() => [])
        : Promise.resolve([])
    ]);

    const leona = {
      configured: !!leonaToken,
      billing_profiles: leonaProfilesRaw,
      found: leonaProfilesRaw.length > 0
    };

    // Sem contato Guru: devolvemos so o lado Leona
    if (!contact) {
      return res.status(200).json({
        email: emailClean,
        leona,
        guru: { contact: null, subscriptions: [], invoices: [] },
        lookback_days: lookbackDays
      });
    }

    // Subscriptions do produto Leona (todos status, nao so ativas, pra
    // suporte poder ver canceladas/expiradas tb)
    const subRes = await fetch(
      `${GURU_BASE}/subscriptions?contact_id=${contact.id}&limit=50`,
      { headers }
    );
    const subBody = subRes.ok ? await subRes.json() : { data: [] };
    const allSubs = Array.isArray(subBody.data) ? subBody.data : [];
    const subs = allSubs
      .filter(s => s.product?.id === LEONA_GURU_PRODUCT_ID)
      .map(s => ({
        id: s.id,
        subscription_code: s.subscription_code,
        status: s.last_status,
        status_at: tsToIso(s.last_status_at),
        offer_id: s.offer?.id || null,
        offer_name: s.offer?.name || null,
        product_id: s.product?.id || null,
        product_name: s.product?.name || null,
        payment_method: s.payment_method,
        cycle_start: s.cycle_start_date,
        cycle_end: s.cycle_end_date,
        next_cycle: s.next_cycle_at,
        cancelled_at: tsToIso(s.cancelled_at)
      }));

    // Transacoes do contato — sem filtro de data na Guru (ordered_at_ini
    // devolve vazio em varios casos). Filtramos localmente por charge_at /
    // confirmed_at, igual guru-search.js faz no portal.
    const txRes = await fetch(
      `${GURU_BASE}/transactions?contact_id=${contact.id}&limit=200`,
      { headers }
    );
    const txBody = txRes.ok ? await txRes.json() : { data: [] };
    const allTx = Array.isArray(txBody.data) ? txBody.data : [];

    const subIds = new Set();
    for (const s of subs) {
      if (s.id) subIds.add(s.id);
      if (s.subscription_code) subIds.add(s.subscription_code);
    }

    const leonaTx = allTx.filter(t =>
      t.invoice &&
      (t.product?.internal_id === LEONA_GURU_PRODUCT_ID ||
        subIds.has(t.subscription?.internal_id) ||
        subIds.has(t.subscription?.code)) &&
      isWithinLookback(t, sinceMs)
    );

    // Dedup por invoice.id — se houver mais de uma transacao, prefere
    // approved (reembolsavel) pra exibir no suporte.
    const invoiceMap = new Map();
    for (const t of leonaTx) {
      const key = t.invoice.id;
      const mapped = mapTransactionToInvoice(t);
      const existing = invoiceMap.get(key);
      if (!existing) {
        invoiceMap.set(key, mapped);
        continue;
      }
      if (mapped.transaction_status === 'approved' && existing.transaction_status !== 'approved') {
        invoiceMap.set(key, mapped);
      }
    }

    const invoices = Array.from(invoiceMap.values()).sort((a, b) => {
      const da = a.charge_at || a.confirmed_at || a.ordered_at || '';
      const db = b.charge_at || b.confirmed_at || b.ordered_at || '';
      return String(db).localeCompare(String(da));
    });

    return res.status(200).json({
      email: emailClean,
      leona,
      guru: {
        contact: {
          id: contact.id,
          email: contact.email,
          name: contact.name || null,
          doc: contact.doc || null,
          phone_local_code: contact.phone_local_code || null,
          phone_number: contact.phone_number || null
        },
        subscriptions: subs,
        invoices
      },
      lookback_days: lookbackDays
    });
  } catch (error) {
    console.error('support-search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
