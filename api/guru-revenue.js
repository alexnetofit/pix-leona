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
 *   Como o painel oficial da Guru (e a contabilidade) usa o dia em
 *   America/Sao_Paulo (UTC-3), uma query com `start=end=hoje` em BR
 *   deixa de fora vendas das ~3 ultimas horas do dia BR (que ja estao
 *   no proximo dia UTC) e inclui ~3 horas de ontem BR.
 *
 *   Solucao: alargamos o intervalo +-1 dia e, ao processar a resposta,
 *   convertemos a data de cada transacao pra dia em SP. So somamos as
 *   que caem no [start, end] BR.
 *
 * Performance:
 *   - Pra acelerar, dividimos o intervalo UTC em dias e disparamos
 *     1 fetch por dia em paralelo (Promise.all). Cada dia ainda pode
 *     paginar internamente com cursor, mas isso e raro pra 1 dia de
 *     transacoes do Leona.
 *   - per_page = 100 (sweet spot da Guru: 250 deixa cada request ~3x
 *     mais lento sem ganho proporcional).
 *
 * Tambem soma separadamente reembolsos (refunded/chargeback) no
 * periodo pra debug, sem subtrair do bruto/liquido reportado.
 */
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';

const APPROVED_STATUSES = ['approved', 'completed'];
const REFUND_STATUSES = ['refunded', 'chargeback'];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_DAY = 50;
const MAX_DAYS_PARALLEL = 60; // limita pra nao explodir a Guru

const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function shiftDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function daysBetween(startIso, endIso) {
  const out = [];
  let cur = startIso;
  while (cur <= endIso && out.length < MAX_DAYS_PARALLEL + 5) {
    out.push(cur);
    cur = shiftDays(cur, 1);
  }
  return out;
}

function toSPDate(value) {
  if (value == null || value === '') return null;

  // A Guru retorna algumas datas como ISO string e outras como Unix
  // timestamp em segundos (ex: dates.ordered_at). Date(number) espera
  // milissegundos, entao normalizamos antes.
  const rawNumber = typeof value === 'number'
    ? value
    : (/^\d+$/.test(String(value)) ? Number(value) : null);
  const d = rawNumber != null
    ? new Date(rawNumber < 100000000000 ? rawNumber * 1000 : rawNumber)
    : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return SP_DATE_FMT.format(d);
}

/**
 * O retorno do GET /transactions tem a data em locais possivelmente
 * diferentes do webhook. Tentamos varios caminhos conhecidos.
 */
function extractOrderedAt(t) {
  return (
    t?.dates?.ordered_at ||
    t?.ordered_at ||
    t?.dates?.confirmed_at ||
    t?.confirmed_at ||
    t?.dates?.created_at ||
    t?.created_at ||
    t?.invoice?.charge_at ||
    t?.invoice?.created_at ||
    t?.payment?.processing_times?.finished_at ||
    t?.payment?.processing_times?.started_at ||
    null
  );
}

function buildUrl(day, cursor) {
  const u = new URL(`${GURU_BASE}/transactions`);
  u.searchParams.set('product_id', LEONA_GURU_PRODUCT_ID);
  u.searchParams.set('ordered_at_ini', day);
  u.searchParams.set('ordered_at_end', day);
  u.searchParams.set('per_page', String(PAGE_SIZE));
  for (const st of [...APPROVED_STATUSES, ...REFUND_STATUSES]) {
    u.searchParams.append('transaction_status[]', st);
  }
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

async function fetchDay(day, headers) {
  const all = [];
  let cursor = null;
  let pages = 0;
  while (pages < MAX_PAGES_PER_DAY) {
    pages++;
    const r = await fetch(buildUrl(day, cursor), { headers });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      const err = new Error(`Guru ${r.status} no dia ${day}: ${errBody.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    const body = await r.json();
    const data = Array.isArray(body.data) ? body.data : [];
    all.push(...data);
    if (!body.has_more_pages || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return { day, transactions: all, pages };
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

  // Para cobrir o dia BR, basta buscar o proprio dia UTC e o dia UTC
  // seguinte. Ex: 11/05 BR termina em 12/05 02:59 UTC.
  const guruIni = start;
  const guruEnd = shiftDays(end, 1);
  const days = daysBetween(guruIni, guruEnd);

  if (days.length > MAX_DAYS_PARALLEL) {
    return res.status(400).json({
      error: `Intervalo grande demais (${days.length} dias). Máximo: ${MAX_DAYS_PARALLEL} dias.`
    });
  }

  const headers = guruHeaders(guruToken);

  let gross = 0;
  let net = 0;
  let count = 0;
  let refundGross = 0;
  let refundNet = 0;
  let refundCount = 0;
  let scanned = 0;
  let withDate = 0;
  let withoutDate = 0;
  let firstSampleKeys = null;
  let totalPages = 0;

  try {
    const t0 = Date.now();
    const results = await Promise.all(days.map(d => fetchDay(d, headers)));
    const fetchMs = Date.now() - t0;

    const seen = new Set(); // dedup por id (transacoes podem repetir entre dias)

    for (const { transactions, pages } of results) {
      totalPages += pages;
      for (const t of transactions) {
        if (t?.product?.internal_id !== LEONA_GURU_PRODUCT_ID) continue;
        const id = t?.id || t?.invoice?.id || JSON.stringify([t?.subscription?.id, t?.payment?.marketplace_id]);
        if (seen.has(id)) continue;
        seen.add(id);

        if (!firstSampleKeys) {
          firstSampleKeys = {
            top_level_keys: Object.keys(t || {}),
            dates_keys: t?.dates ? Object.keys(t.dates) : null,
            invoice_keys: t?.invoice ? Object.keys(t.invoice) : null
          };
        }

        const ordered = extractOrderedAt(t);
        const spDay = toSPDate(ordered);
        if (spDay) {
          withDate++;
          if (spDay < start || spDay > end) continue;
        } else {
          withoutDate++;
        }

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
      pages_fetched: totalPages,
      days_queried: days.length,
      transactions_in_range: scanned,
      fetch_ms: fetchMs,
      _debug: {
        with_date_field: withDate,
        without_date_field: withoutDate,
        sample_keys: firstSampleKeys
      }
    });
  } catch (e) {
    console.error('guru-revenue error:', e);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
