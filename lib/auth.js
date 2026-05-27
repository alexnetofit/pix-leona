/**
 * lib/auth.js — Helpers de auth e CORS pros endpoints `api/*`.
 *
 * Três funções:
 *
 *   applyCors(req, res)
 *     Aplica os headers de CORS conforme whitelist em CORS_ALLOWED_ORIGINS
 *     (lista separada por vírgula). Se a env não estiver configurada,
 *     mantém comportamento permissivo (`*`) pra não quebrar deploy local
 *     ou rollout gradual. Trata o preflight OPTIONS retornando true (o
 *     handler deve dar `return` quando isso acontecer).
 *
 *   requireAdmin(req)
 *     Lê `Authorization: Bearer <token>` e compara com TOKEN_ADMIN.
 *     Devolve `{ ok, reason }`. NÃO chama res.* — quem decide o que fazer
 *     com o resultado é o `enforceAuth` abaixo.
 *
 *   enforceAuth(req, res, authResult, { route })
 *     Aplica o resultado de `requireAdmin` levando em conta a env
 *     AUTH_ENFORCEMENT:
 *
 *       warn (default)  -> só loga a falha, devolve false (handler segue)
 *       deny            -> retorna 401 com JSON e devolve true (handler para)
 *
 *     Padrão é `warn` pra rollout seguro: deploya o código, monitora os
 *     logs por 1-2 dias pra detectar caller esquecido, e quando estiver
 *     limpo basta mudar a env pra `deny` na Vercel — sem redeploy.
 */

const ADMIN_ENV = 'TOKEN_ADMIN';
const SUPPORT_ENV = 'SUPPORT_CHAT_TOKEN';

function getAllowedOrigins() {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw || !raw.trim()) return null; // null = wildcard (compat)
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = getAllowedOrigins();

  if (allowed === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowed[0] || 'null');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function extractBearer(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : null;
}

export function requireAdmin(req) {
  const expected = process.env[ADMIN_ENV];
  if (!expected) {
    return { ok: false, reason: `${ADMIN_ENV} não configurado no servidor` };
  }
  const provided = extractBearer(req);
  if (!provided) {
    return { ok: false, reason: 'Authorization: Bearer ausente' };
  }
  if (provided !== expected) {
    return { ok: false, reason: 'Token admin inválido' };
  }
  return { ok: true };
}

/** Token da pagina /suporte (env SUPPORT_CHAT_TOKEN). */
export function requireSupport(req) {
  const expected = process.env[SUPPORT_ENV];
  if (!expected) {
    return { ok: false, reason: `${SUPPORT_ENV} não configurado no servidor` };
  }
  const provided = extractBearer(req);
  if (!provided) {
    return { ok: false, reason: 'Authorization: Bearer ausente' };
  }
  if (provided !== expected) {
    return { ok: false, reason: 'Token de suporte inválido' };
  }
  return { ok: true };
}

function getEnforcementMode() {
  const mode = (process.env.AUTH_ENFORCEMENT || 'warn').toLowerCase();
  return mode === 'deny' ? 'deny' : 'warn';
}

/**
 * Aplica o resultado de uma checagem de auth.
 *
 * Retorna:
 *   true   -> o handler deve dar `return` IMEDIATAMENTE (resposta já enviada)
 *   false  -> handler pode seguir
 */
export function enforceAuth(req, res, authResult, opts = {}) {
  if (authResult?.ok) return false;

  const route = opts.route || req.url || 'unknown';
  const mode = getEnforcementMode();
  const reason = authResult?.reason || 'auth ausente';
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';

  const tag = mode === 'deny' ? '[auth:deny]' : '[auth:warn]';
  console.warn(`${tag} route=${route} reason="${reason}" ip=${ip} ua="${ua}"`);

  if (mode === 'deny') {
    res.status(401).json({ error: 'Unauthorized', reason });
    return true;
  }
  return false;
}
