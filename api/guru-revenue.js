/**
 * api/guru-revenue.js — Faturamento bruto e liquido do produto Leona na Guru.
 *
 * Body JSON:
 *   {
 *     token: "<TOKEN_ADMIN>",   // gating
 *     start: "YYYY-MM-DD",      // filtro ordered_at_ini
 *     end:   "YYYY-MM-DD"       // filtro ordered_at_end
 *   }
 *
 * Filtra transacoes do produto Leona (LEONA_GURU_PRODUCT_ID) com status
 * "approved" e soma payment.gross / payment.net. Pagina automaticamente
 * com next_cursor ate cobrir todo o intervalo.
 *
 * Tambem soma separadamente reembolsos (refunded/chargeback) no periodo
 * pra debug, sem subtrair do bruto/liquido reportado (regra simples,
 * "faturamento bruto e liquido" = somente vendas aprovadas no periodo).
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const PAGE_SIZE = 250;
const MAX_PAGES = 200;

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function buildUrl(start, end, cursor) {
  const u = new URL(`${GURU_BASE}/transactions`);
  u.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  u.searchParams.set('ordered_at_ini', start);
  u.searchParams.set('ordered_at_end', end);
  u.searchParams.set('per_page', String(PAGE_SIZE));
  for (const st of [...APPROVED_STATUSES, ...REFUND_STATUSES]) {
    u.searchParams.append('transaction_status[]', st);
  }
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const guruToken = process.env.GURU_TOKEN;
  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });

  const { start, end } = req.body || {};

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'Informe start e end no formato YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ error: 'start não pode ser maior que end' });
  }

  const headers = guruHeaders(guruToken);

  let gross = 0;
  let net = 0;
  let count = 0;
  let refundGross = 0;
  let refundNet = 0;
  let refundCount = 0;
  let pages = 0;
  let cursor = null;

  try {
    while (pages < MAX_PAGES) {
      pages++;
      const url = buildUrl(start, end, cursor);
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        return res.status(502).json({
          error: `Guru retornou ${r.status} ao buscar transações`,
          detail: errBody.slice(0, 500),
          page: pages
        });
      }
      const body = await r.json();
      const data = Array.isArray(body.data) ? body.data : [];

      for (const t of data) {
        if (t?.product?.internal_id !== LEONA_GURU_PRODUCT_ID) continue;
        const status = String(t?.status || '').toLowerCase();
        const g = Number(t?.payment?.gross) || 0;
        const n = Number(t?.payment?.net) || 0;

        if (APPROVED_STATUSES.includes(status)) {
          gross += g;
          net += n;
          count++;
        } else if (REFUND_STATUSES.includes(status)) {
          refundGross += g;
          refundNet += n;
          refundCount++;
        }
      }

      if (!body.has_more_pages || !body.next_cursor) break;
      cursor = body.next_cursor;
    }

    return res.status(200).json({
      product_id: LEONA_GURU_PRODUCT_ID,
      range: { start, end },
      approved: {
        gross: Math.round(gross * 100) / 100,
        net: Math.round(net * 100) / 100,
        count
      },
      refunded: {
        gross: Math.round(refundGross * 100) / 100,
        net: Math.round(refundNet * 100) / 100,
        count: refundCount
      },
      pages_fetched: pages
    });
  } catch (e) {
    console.error('guru-revenue error:', e);
    return res.status(500).json({ error: e.message });
  }
}
