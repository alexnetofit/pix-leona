/**
 * api/guru-revenue.js — Faturamento bruto e liquido do produto Leona na Guru.
 *
 * Body JSON:
 *   {
 *     start: "YYYY-MM-DD",   // dia inicial em America/Sao_Paulo (BR)
 *     end:   "YYYY-MM-DD"    // dia final em America/Sao_Paulo (BR)
 *   }
 *
 * IMPORTANTE — fuso:
 *   A API da Guru filtra `ordered_at_ini`/`ordered_at_end` em UTC.
 *   Como o painel oficial da Guru (e a contabilidade do cliente) usa
 *   o dia em America/Sao_Paulo (UTC-3), uma query com `start=end=hoje`
 *   em BR deixa de fora vendas das ~3 ultimas horas do dia BR (que ja
 *   estao no proximo dia UTC) e inclui ~3 horas de ontem BR.
 *
 *   Solucao: alargamos o intervalo enviado a Guru em +-1 dia e, em
 *   seguida, filtramos cada transacao convertendo `dates.ordered_at`
 *   (UTC) pro dia em SP. Assim, somamos exatamente o que cai no dia BR.
 *
 * Tambem soma separadamente reembolsos (refunded/chargeback) no
 * periodo pra debug, sem subtrair do bruto/liquido reportado.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const PAGE_SIZE = 250;
const MAX_PAGES = 200;

const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function shiftDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  // Usa UTC pra evitar artefatos de DST locais; soh queremos calendario.
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function toSPDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return SP_DATE_FMT.format(d); // "YYYY-MM-DD" em America/Sao_Paulo
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

  // Alarga +-1 dia pra cobrir a borda do fuso UTC vs SP.
  const guruIni = shiftDays(start, -1);
  const guruEnd = shiftDays(end, 1);

  const headers = guruHeaders(guruToken);

  let gross = 0;
  let net = 0;
  let count = 0;
  let refundGross = 0;
  let refundNet = 0;
  let refundCount = 0;
  let pages = 0;
  let scanned = 0;
  let cursor = null;

  try {
    while (pages < MAX_PAGES) {
      pages++;
      const url = buildUrl(guruIni, guruEnd, cursor);
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

        // Filtra pelo dia BR usando dates.ordered_at (ISO UTC).
        const ordered = t?.dates?.ordered_at || t?.dates?.confirmed_at || null;
        const spDay = toSPDate(ordered);
        if (!spDay || spDay < start || spDay > end) continue;

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

    return res.status(200).json({
      product_id: LEONA_GURU_PRODUCT_ID,
      range: { start, end },
      guru_query_range: { start: guruIni, end: guruEnd },
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
      transactions_in_range: scanned
    });
  } catch (e) {
    console.error('guru-revenue error:', e);
    return res.status(500).json({ error: e.message });
  }
}
