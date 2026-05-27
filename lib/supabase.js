/**
 * lib/supabase.js — Cliente leve pra Supabase via PostgREST.
 *
 * Sem dependencia npm (`@supabase/supabase-js`) pra manter o `pix-leona`
 * stateless e zero-build, igual o resto do projeto. Usa fetch direto
 * contra a REST API com a service_role_key (acesso server-side total,
 * bypassa RLS).
 *
 * Envs necessarias:
 *   - SUPABASE_URL              (ex: https://xxx.supabase.co)
 *   - SUPABASE_SERVICE_ROLE_KEY (formato eyJ... — NAO usar anon key aqui)
 *
 * Helpers:
 *   - sbInsert(table, payload, opts)  -> INSERT com return=representation
 *   - sbSelect(table, query)          -> GET com filtros tipo PostgREST
 *   - sbUpdate(table, filter, patch)  -> PATCH com filtros
 *   - sbConfigured()                  -> bool, util pra checar antes
 */

function getCreds() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

export function sbConfigured() {
  return !!getCreds();
}

function defaultHeaders(key, extra = {}) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

/**
 * Insere uma ou mais rows. Retorna a row inserida (com ID gerado, etc).
 *
 *   const row = await sbInsert('support_actions', { type, reason, ... });
 *   // row.id, row.created_at, ...
 */
export async function sbInsert(table, payload, opts = {}) {
  const creds = getCreds();
  if (!creds) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nao configurado');

  const headers = defaultHeaders(creds.key, {
    'Prefer': 'return=representation'
  });

  const r = await fetch(`${creds.url}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`sbInsert ${table} falhou (${r.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  // Insert com array retorna array; com objeto retorna [obj]. Sempre array.
  if (opts.single !== false && Array.isArray(body)) return body[0];
  return body;
}

/**
 * SELECT com filtros estilo PostgREST. `query` e um objeto com:
 *   - select: string (default '*')
 *   - eq:     { col: value }
 *   - in:     { col: [v1, v2] }
 *   - order:  string (ex: 'created_at.desc')
 *   - limit:  number
 *
 *   const rows = await sbSelect('support_actions', {
 *     eq: { status: 'pending' },
 *     order: 'created_at.desc',
 *     limit: 50
 *   });
 */
export async function sbSelect(table, query = {}) {
  const creds = getCreds();
  if (!creds) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nao configurado');

  const params = new URLSearchParams();
  params.set('select', query.select || '*');

  if (query.eq) {
    for (const [col, val] of Object.entries(query.eq)) {
      params.append(col, `eq.${val}`);
    }
  }
  if (query.in) {
    for (const [col, vals] of Object.entries(query.in)) {
      params.append(col, `in.(${vals.map(v => String(v)).join(',')})`);
    }
  }
  if (query.order) params.set('order', query.order);
  if (query.limit) params.set('limit', String(query.limit));

  const r = await fetch(`${creds.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`, {
    headers: defaultHeaders(creds.key)
  });

  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`sbSelect ${table} falhou (${r.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return Array.isArray(body) ? body : [];
}

/**
 * UPDATE com filtros. Retorna a(s) row(s) atualizada(s).
 *
 *   const row = await sbUpdate('support_actions',
 *     { id: '...' },
 *     { status: 'approved', decided_at: new Date().toISOString() }
 *   );
 */
export async function sbUpdate(table, filter, patch, opts = {}) {
  const creds = getCreds();
  if (!creds) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nao configurado');

  const params = new URLSearchParams();
  for (const [col, val] of Object.entries(filter || {})) {
    params.append(col, `eq.${val}`);
  }

  const headers = defaultHeaders(creds.key, {
    'Prefer': 'return=representation'
  });

  const r = await fetch(`${creds.url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch)
  });

  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`sbUpdate ${table} falhou (${r.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  if (opts.single !== false && Array.isArray(body)) return body[0];
  return body;
}
