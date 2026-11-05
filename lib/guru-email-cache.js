/**
 * lib/guru-email-cache.js — Se o e-mail ainda tem assinatura Leona ativa na
 * Guru, guardado em `guru_email_active`.
 *
 * O snapshot de assinantes (cron de 5 em 5 minutos) cruza Paddle, Pagou e
 * Pagar.me com a Guru para não contar a mesma pessoa duas vezes. Perguntar
 * isso e-mail por e-mail dava ~3,3 mil GET /contacts a cada rodada. A resposta
 * quase não muda no intervalo de um dia, então cada e-mail é consultado uma
 * vez e volta pra fila só quando a validade vence.
 *
 * Sem a tabela (ou com o Supabase fora), não consulta a Guru: um cache
 * quebrado nunca pode voltar a gerar a rajada.
 */
import { sbConfigured, sbSelectWhere, sbUpsert } from './supabase.js';
import { GURU_BASE, LEONA_GURU_PRODUCT_ID } from './guru.js';

export const GURU_EMAIL_CACHE_TABLE = 'guru_email_active';
export const MAX_GURU_LOOKUPS_PER_RUN = 250;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const INACTIVE_TTL_MS = 24 * HOUR;
const INACTIVE_JITTER_MS = 6 * HOUR;
const ACTIVE_MAX_TTL_MS = 24 * HOUR;
const ACTIVE_MIN_TTL_MS = 15 * MINUTE;
const AFTER_CYCLE_END_MS = 5 * MINUTE;
const ERROR_RETRY_MS = 15 * MINUTE;
const READ_CHUNK = 150;
const WRITE_CHUNK = 500;
const LOOKUP_CONCURRENCY = 4;
const USER_AGENT = 'pix-leona-revenue';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cycleEndMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59-03:00` : raw;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function guruHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT
  };
}

/**
 * Quando consultar esse e-mail de novo.
 *   - sem assinatura ativa: 24h + até 6h de sorteio;
 *   - com assinatura: no fim do ciclo, entre 15 min e 24h.
 */
export function nextGuruRecheckAt(active, cycleEnd, { now = Date.now(), random = Math.random } = {}) {
  const daily = INACTIVE_TTL_MS + Math.floor(random() * INACTIVE_JITTER_MS);
  if (!active) return new Date(now + daily);
  const end = cycleEndMs(cycleEnd);
  const untilEnd = end == null ? ACTIVE_MAX_TTL_MS : end + AFTER_CYCLE_END_MS - now;
  const ttl = Math.min(Math.min(daily, ACTIVE_MAX_TTL_MS), Math.max(ACTIVE_MIN_TTL_MS, untilEnd));
  return new Date(now + ttl);
}

export function cacheRowFromLookup(email, result, { now = Date.now(), random = Math.random } = {}) {
  const active = !!result?.active;
  const cycleEnd = active && result?.cycleEnd ? String(result.cycleEnd).slice(0, 10) : null;
  return {
    email,
    active,
    cycle_end: cycleEnd,
    checked_at: new Date(now).toISOString(),
    recheck_at: nextGuruRecheckAt(active, cycleEnd, { now, random }).toISOString(),
    last_error: null,
    updated_at: new Date(now).toISOString()
  };
}

function cacheRowAfterError(email, previous, error, now) {
  return {
    email,
    active: previous?.active ?? null,
    cycle_end: previous?.cycle_end ?? null,
    checked_at: previous?.checked_at ?? null,
    recheck_at: new Date(now + ERROR_RETRY_MS).toISOString(),
    last_error: String(error || 'falha').slice(0, 300),
    updated_at: new Date(now).toISOString()
  };
}

/** Novos primeiro, depois os vencidos mais antigos. O resto espera a próxima rodada. */
export function pickGuruEmailsToLookup(emails, cache, { now = Date.now(), max = MAX_GURU_LOOKUPS_PER_RUN } = {}) {
  const missing = [];
  const expired = [];
  for (const email of emails) {
    const row = cache.get(email);
    if (!row) {
      missing.push(email);
      continue;
    }
    const due = new Date(row.recheck_at || 0).getTime();
    if (!Number.isFinite(due) || due <= now) expired.push({ email, due: Number.isFinite(due) ? due : 0 });
  }
  expired.sort((a, b) => a.due - b.due);
  const ordered = [...missing, ...expired.map((entry) => entry.email)];
  return {
    lookup: ordered.slice(0, Math.max(0, max)),
    missing: missing.length,
    expired: expired.length,
    deferred: Math.max(0, ordered.length - Math.max(0, max))
  };
}

export function overlapFromCache(emails, cache) {
  const overlap = [];
  for (const email of emails) {
    const row = cache.get(email);
    if (row?.active === true) overlap.push(email);
  }
  return overlap;
}

/**
 * Assinatura Leona ativa na Guru para um e-mail.
 * HTTP diferente de 200 é erro: não pode ser gravado como "sem assinatura".
 */
export async function lookupGuruActive(email, guruToken, { fetchImpl = fetch } = {}) {
  const emailClean = normalizeEmail(email);
  if (!emailClean || !guruToken) return { ok: false, error: 'sem email ou token' };
  try {
    const contactRes = await fetchImpl(
      `${GURU_BASE}/contacts?email=${encodeURIComponent(emailClean)}&limit=20`,
      { headers: guruHeaders(guruToken) }
    );
    if (!contactRes.ok) return { ok: false, error: `HTTP ${contactRes.status}` };
    const contactBody = await contactRes.json().catch(() => ({}));
    const contacts = Array.isArray(contactBody.data) ? contactBody.data : [];
    const contact = contacts.find((item) => item.email?.toLowerCase() === emailClean) || null;
    if (!contact?.id) return { ok: true, active: false, cycleEnd: null };

    const subRes = await fetchImpl(
      `${GURU_BASE}/subscriptions?contact_id=${encodeURIComponent(contact.id)}&limit=50`,
      { headers: guruHeaders(guruToken) }
    );
    if (!subRes.ok) return { ok: false, error: `HTTP ${subRes.status}` };
    const subBody = await subRes.json().catch(() => ({}));
    const subs = (Array.isArray(subBody.data) ? subBody.data : []).filter((sub) =>
      sub.product?.id === LEONA_GURU_PRODUCT_ID && sub.last_status === 'active'
    );
    if (!subs.length) return { ok: true, active: false, cycleEnd: null };
    const ends = subs.map((sub) => sub.cycle_end_date).filter(Boolean).sort();
    return { ok: true, active: true, cycleEnd: ends[0] || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function defaultReadCache(emails) {
  const cache = new Map();
  for (let i = 0; i < emails.length; i += READ_CHUNK) {
    const chunk = emails.slice(i, i + READ_CHUNK);
    const rows = await sbSelectWhere(GURU_EMAIL_CACHE_TABLE, {
      select: 'email,active,cycle_end,checked_at,recheck_at',
      in: { email: chunk.map((email) => `"${email.replace(/"/g, '')}"`) },
      limit: chunk.length
    });
    for (const row of rows) cache.set(normalizeEmail(row.email), row);
  }
  return cache;
}

async function defaultWriteCache(rows) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await sbUpsert(GURU_EMAIL_CACHE_TABLE, rows.slice(i, i + WRITE_CHUNK), {
      onConflict: 'email',
      single: false
    });
  }
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => loop()));
}

/**
 * E-mails da lista que ainda têm assinatura Leona ativa na Guru.
 * Gasta no máximo `maxLookups` consultas na Guru por rodada.
 */
export async function resolveGuruOverlapEmails(emails, {
  guruToken,
  now = Date.now(),
  random = Math.random,
  maxLookups = MAX_GURU_LOOKUPS_PER_RUN,
  cacheEnabled = sbConfigured,
  readCache = defaultReadCache,
  writeCache = defaultWriteCache,
  lookup = (email) => lookupGuruActive(email, guruToken)
} = {}) {
  const unique = [...new Set((emails || []).map(normalizeEmail).filter((email) => email.includes('@')))];
  const stats = {
    emails: unique.length,
    cache: 'ok',
    missing: 0,
    expired: 0,
    looked_up: 0,
    deferred: 0,
    errors: 0,
    write_failed: false,
    overlap: 0
  };
  if (!unique.length) return { emails: [], stats };
  if (!guruToken || !cacheEnabled()) {
    stats.cache = guruToken ? 'unconfigured' : 'no_token';
    return { emails: [], stats };
  }

  let cache;
  try {
    cache = await readCache(unique);
  } catch (error) {
    console.error('guru-email-cache: leitura falhou, sem consulta à Guru nesta rodada:', error.message);
    stats.cache = 'unavailable';
    return { emails: [], stats };
  }

  const plan = pickGuruEmailsToLookup(unique, cache, { now, max: maxLookups });
  stats.missing = plan.missing;
  stats.expired = plan.expired;
  stats.deferred = plan.deferred;

  const written = [];
  await runPool(plan.lookup, async (email) => {
    const result = await lookup(email);
    stats.looked_up++;
    const row = result?.ok
      ? cacheRowFromLookup(email, result, { now, random })
      : cacheRowAfterError(email, cache.get(email), result?.error, now);
    if (!result?.ok) stats.errors++;
    cache.set(email, row);
    written.push(row);
  }, LOOKUP_CONCURRENCY);

  if (written.length) {
    try {
      await writeCache(written);
    } catch (error) {
      console.error('guru-email-cache: gravação falhou:', error.message);
      stats.write_failed = true;
    }
  }

  const overlap = overlapFromCache(unique, cache);
  stats.overlap = overlap.length;
  return { emails: overlap, stats };
}
