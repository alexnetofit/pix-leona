/**
 * api/guru-revenue.js — Faturamento bruto e liquido do produto Leona na Guru.
 *
 * Body JSON:
 *   {
 *     start: "YYYY-MM-DD",   // dia inicial em America/Sao_Paulo (BR)
 *     end:   "YYYY-MM-DD"    // dia final em America/Sao_Paulo (BR)
 *   }
 *
 * A pagina de analytics da Guru agrupa vendas por `confirmed_at` (data
 * em que a venda foi confirmada/paga), nao por `ordered_at`. Usar
 * `confirmed_at_ini/end` bate com o grafico oficial da Guru.
 *
 * Tambem soma separadamente reembolsos (refunded/chargeback) no
 * periodo pra debug, sem subtrair do bruto/liquido reportado.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function buildUrl(start, end, cursor) {
  const u = new URL(`${GURU_BASE}/transactions`);
  u.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  u.searchParams.set('confirmed_at_ini', start);
  u.searchParams.set('confirmed_at_end', end);
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const expectedToken = process.env.SUPPORT_CHAT_TOKEN?.trim();
  if (!expectedToken) return res.status(500).json({ error: 'SUPPORT_CHAT_TOKEN não configurado' });

  const auth = req.headers.authorization || '';
  const providedToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Token inválido' });
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
  let scanned = 0;
  let pages = 0;
  let cursor = null;

  try {
    const t0 = Date.now();
    const seen = new Set(); // dedup por id (transacoes podem repetir entre dias)

    while (pages < MAX_PAGES) {
      pages++;
      const r = await fetch(buildUrl(start, end, cursor), { headers });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        return res.status(502).json({
          error: `Guru retornou ${r.status} ao buscar transações`,
          detail: errBody.slice(0, 500),
          page: pages
        });
      }

      const body = await r.json();
      const transactions = Array.isArray(body.data) ? body.data : [];

      for (const t of transactions) {
        if (t?.product?.internal_id !== LEONA_GURU_PRODUCT_ID) continue;
        const id = t?.id || t?.invoice?.id || JSON.stringify([t?.subscription?.id, t?.payment?.marketplace_id]);
        if (seen.has(id)) continue;
        seen.add(id);

        scanned++;
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
    const fetchMs = Date.now() - t0;

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
      pages_fetched: pages,
      transactions_in_range: scanned,
      fetch_ms: fetchMs
    });
  } catch (e) {
    console.error('guru-revenue error:', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
