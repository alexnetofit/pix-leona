/**
 * lib/leona-account-cache.js — Quantas contas Leona ativas cada e-mail tem,
 * guardado em `leona_email_accounts`.
 *
 * O snapshot de assinantes (cron de 5 em 5 minutos) precisa saber quem é dono
 * de mais de uma conta ativa. Perguntar isso pra Leona a cada rodada, e-mail
 * por e-mail, dava ~38 mil chamadas por hora. A resposta quase nunca muda:
 * conta nova paga pelo nosso checkout já chega pelas intents, e conta só
 * deixa de ser ativa no vencimento, que vem no próprio perfil. Então cada
 * e-mail é consultado uma vez e volta pra fila só quando a validade vence.
 *
 * Sem a tabela (ou com o Supabase fora), não consulta a Leona: um cache
 * quebrado nunca pode voltar a gerar a rajada.
 */
import { sbConfigured, sbSelectWhere, sbUpsert } from './supabase.js';
import { isLeonaProfileActivelyPaid, lookupLeonaAccountsByEmail } from './leona.js';

export const LEONA_ACCOUNT_CACHE_TABLE = 'leona_email_accounts';
export const MAX_LEONA_LOOKUPS_PER_RUN = 250;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SINGLE_ACCOUNT_TTL_MS = 24 * HOUR;
const SINGLE_ACCOUNT_JITTER_MS = 6 * HOUR;
const MULTI_ACCOUNT_MAX_TTL_MS = 12 * HOUR;
const MULTI_ACCOUNT_MIN_TTL_MS = 15 * MINUTE;
const AFTER_PERIOD_END_MS = 5 * MINUTE;
const ERROR_RETRY_MS = 15 * MINUTE;
const READ_CHUNK = 150;
const WRITE_CHUNK = 500;
const LOOKUP_CONCURRENCY = 5;
const USER_AGENT = 'pix-leona-revenue';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function periodEndMs(profile) {
  const ts = new Date(profile?.current_period_end || profile?.due_date || '').getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Quando consultar esse e-mail de novo.
 *   - uma conta (ou nenhuma): 24h + até 6h de sorteio, pra não juntar todo
 *     mundo no mesmo minuto;
 *   - duas ou mais: logo depois do vencimento mais próximo, entre 15 min e 12h,
 *     porque é o único caso em que o número de extras muda sozinho.
 */
export function nextLeonaRecheckAt(profiles, { now = Date.now(), random = Math.random } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length <= 1) {
    return new Date(now + SINGLE_ACCOUNT_TTL_MS + Math.floor(random() * SINGLE_ACCOUNT_JITTER_MS));
  }
  const ends = list
    .filter((profile) => isLeonaProfileActivelyPaid(profile, new Date(now)))
    .map(periodEndMs)
    .filter((ts) => ts != null && ts > now);
  const untilEnd = ends.length ? Math.min(...ends) + AFTER_PERIOD_END_MS - now : MULTI_ACCOUNT_MAX_TTL_MS;
  const ttl = Math.min(MULTI_ACCOUNT_MAX_TTL_MS, Math.max(MULTI_ACCOUNT_MIN_TTL_MS, untilEnd));
  return new Date(now + ttl);
}

export function cacheRowFromProfiles(email, profiles, { now = Date.now(), random = Math.random } = {}) {
  const active = profiles.filter((profile) => isLeonaProfileActivelyPaid(profile, new Date(now)));
  return {
    email,
    account_ids: active.map((profile) => String(profile.account_id ?? '')).filter(Boolean),
    active_count: active.length,
    profiles_count: profiles.length,
    checked_at: new Date(now).toISOString(),
    recheck_at: nextLeonaRecheckAt(profiles, { now, random }).toISOString(),
    last_error: null,
    updated_at: new Date(now).toISOString()
  };
}

function cacheRowAfterError(email, previous, error, now) {
  return {
    email,
    account_ids: Array.isArray(previous?.account_ids) ? previous.account_ids : [],
    active_count: previous?.active_count ?? null,
    profiles_count: previous?.profiles_count ?? null,
    checked_at: previous?.checked_at ?? null,
    recheck_at: new Date(now + ERROR_RETRY_MS).toISOString(),
    last_error: String(error || 'falha').slice(0, 300),
    updated_at: new Date(now).toISOString()
  };
}

/**
 * Quem consultar nesta rodada: primeiro e-mail nunca visto (assinante novo),
 * depois os de validade vencida mais antiga. O resto espera a próxima rodada.
 */
export function pickLeonaEmailsToLookup(emails, cache, { now = Date.now(), max = MAX_LEONA_LOOKUPS_PER_RUN } = {}) {
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

export function extrasFromCache(emails, cache) {
  const extras = [];
  for (const email of emails) {
    const row = cache.get(email);
    const extra = Math.max(0, (Number(row?.active_count) || 0) - 1);
    if (extra > 0) extras.push({ email, extra, accountIds: row.account_ids || [] });
  }
  return extras;
}

async function defaultReadCache(emails) {
  const cache = new Map();
  for (let i = 0; i < emails.length; i += READ_CHUNK) {
    const chunk = emails.slice(i, i + READ_CHUNK);
    const rows = await sbSelectWhere(LEONA_ACCOUNT_CACHE_TABLE, {
      select: 'email,account_ids,active_count,profiles_count,checked_at,recheck_at',
      in: { email: chunk.map((email) => `"${email.replace(/"/g, '')}"`) },
      limit: chunk.length
    });
    for (const row of rows) cache.set(normalizeEmail(row.email), row);
  }
  return cache;
}

async function defaultWriteCache(rows) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await sbUpsert(LEONA_ACCOUNT_CACHE_TABLE, rows.slice(i, i + WRITE_CHUNK), {
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
 * Extras de contas Leona (dono com 2+ contas ativas) para a lista de e-mails,
 * gastando no máximo `maxLookups` chamadas na Leona.
 */
export async function resolveExtraActiveLeonaAccounts(emails, {
  leonaToken,
  now = Date.now(),
  random = Math.random,
  maxLookups = MAX_LEONA_LOOKUPS_PER_RUN,
  cacheEnabled = sbConfigured,
  readCache = defaultReadCache,
  writeCache = defaultWriteCache,
  lookup = (email) => lookupLeonaAccountsByEmail(email, leonaToken, { userAgent: USER_AGENT })
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
    write_failed: false
  };
  if (!unique.length) return { extras: [], stats };
  if (!leonaToken || !cacheEnabled()) {
    stats.cache = leonaToken ? 'unconfigured' : 'no_token';
    return { extras: [], stats };
  }

  let cache;
  try {
    cache = await readCache(unique);
  } catch (error) {
    console.error('leona-account-cache: leitura falhou, sem consulta à Leona nesta rodada:', error.message);
    stats.cache = 'unavailable';
    return { extras: [], stats };
  }

  const plan = pickLeonaEmailsToLookup(unique, cache, { now, max: maxLookups });
  stats.missing = plan.missing;
  stats.expired = plan.expired;
  stats.deferred = plan.deferred;

  const written = [];
  await runPool(plan.lookup, async (email) => {
    const result = await lookup(email);
    stats.looked_up++;
    const row = result?.ok
      ? cacheRowFromProfiles(email, result.profiles || [], { now, random })
      : cacheRowAfterError(email, cache.get(email), result?.error, now);
    if (!result?.ok) stats.errors++;
    cache.set(email, row);
    written.push(row);
  }, LOOKUP_CONCURRENCY);

  if (written.length) {
    try {
      await writeCache(written);
    } catch (error) {
      console.error('leona-account-cache: gravação falhou:', error.message);
      stats.write_failed = true;
    }
  }

  return { extras: extrasFromCache(unique, cache), stats };
}
