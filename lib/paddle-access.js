/**
 * lib/paddle-access.js — autorizacao server-side de /api/paddle-search e
 * /api/paddle-subscription.
 *
 * Duas identidades sao aceitas:
 *
 *   staff   -> Authorization: Bearer TOKEN_ADMIN | SUPPORT_CHAT_TOKEN.
 *              Enxerga e mexe em qualquer conta (ferramentas internas e
 *              curl do time de suporte).
 *   cliente -> cookie de sessao Paddle (lib/paddle-session.js), emitido por
 *              /api/paddle-session a partir de um ticket HMAC. Enxerga
 *              SOMENTE a conta que esta assinada no cookie.
 *
 * Sem uma das duas: 401. `account_id` e `email` do body NAO autenticam nada —
 * sao justamente o que um atacante ja tem (lista de leads, vazamento antigo).
 * Quando o caller e cliente, a identidade vem do cookie e o body so pode
 * concordar com ela.
 *
 * O binding dono<->recurso tambem mora aqui. `assertOwnsSubscription` e
 * `assertOwnsTransaction` respondem o MESMO 403 para recurso inexistente e
 * para recurso de outro dono: repassar o `not_found` da Paddle transformaria
 * o endpoint em oraculo de enumeracao de IDs.
 */
import { getLeonaBillingProfile } from './leona.js';
import {
  PaddleSessionError,
  requirePaddleSession,
  timingSafeStringEqual
} from './paddle-session.js';

const PADDLE_BASE = 'https://api.paddle.com';
const STAFF_TOKEN_ENVS = ['TOKEN_ADMIN', 'SUPPORT_CHAT_TOKEN'];

export class PaddleAccessError extends Error {
  constructor(message, { status = 401, code = 'SESSION_REQUIRED' } = {}) {
    super(message);
    this.name = 'PaddleAccessError';
    this.status = status;
    this.code = code;
  }
}

function notOwnerError() {
  return new PaddleAccessError('Recurso não encontrado para esta conta', {
    status: 403,
    code: 'NOT_OWNER'
  });
}

export function sendPaddleAccessError(res, error) {
  if (!(error instanceof PaddleAccessError)) throw error;
  return res.status(error.status).json({
    error: error.message,
    code: error.code
  });
}

function bearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/**
 * Staff = qualquer um dos tokens internos. Comparacao timing-safe porque
 * esses tokens sao a chave mestra de todas as contas.
 */
export function isStaffRequest(req) {
  const provided = bearerToken(req);
  if (!provided) return false;
  return STAFF_TOKEN_ENVS.some(name => {
    const expected = (process.env[name] || '').trim();
    return Boolean(expected) && timingSafeStringEqual(provided, expected);
  });
}

/**
 * Resolve a identidade do caller ou lanca PaddleAccessError.
 *
 * Retorna:
 *   { staff: true,  accountId: null, profile: null, email: null }
 *   { staff: false, accountId, profile, email }
 */
export async function requirePaddleAccess(req, { leonaToken } = {}) {
  if (isStaffRequest(req)) {
    return { staff: true, accountId: null, profile: null, email: null };
  }

  // Sem PADDLE_LINK_SECRET nao existe sessao de cliente possivel. Falha
  // explicita (503 + code) em vez de 401 genérico pra nao mandar o operador
  // caçar o motivo no log.
  if (!String(process.env.PADDLE_LINK_SECRET || '').trim()) {
    throw new PaddleAccessError(
      'Sessão de cliente indisponível: PADDLE_LINK_SECRET não configurado',
      { status: 503, code: 'BILLING_SESSION_UNCONFIGURED' }
    );
  }

  let session;
  try {
    session = requirePaddleSession(req);
  } catch (error) {
    const code = error instanceof PaddleSessionError ? error.code : 'SESSION_REQUIRED';
    throw new PaddleAccessError(
      'Sessão ausente ou expirada. Abra esta página pelo painel do Leona.',
      { status: 401, code }
    );
  }

  if (!leonaToken) {
    throw new PaddleAccessError('LEONA_BILLING_TOKEN não configurado', {
      status: 500,
      code: 'LEONA_TOKEN_MISSING'
    });
  }

  const accountId = String(session.account_id).trim();
  const profile = await getLeonaBillingProfile(accountId, leonaToken);
  if (!profile) {
    throw new PaddleAccessError('Conta não encontrada', {
      status: 404,
      code: 'ACCOUNT_NOT_FOUND'
    });
  }

  const email = profile.user?.email
    ? String(profile.user.email).trim().toLowerCase()
    : null;

  return { staff: false, accountId, profile, email };
}

/**
 * O body pode repetir a identidade (a UI antiga sempre manda), mas nunca
 * contradizer o cookie. Reusa o code EMAIL_ID_MISMATCH que o front ja trata
 * com a tela de "dados do link não correspondem".
 */
export function assertBodyIdentityMatches(access, { accountId, email } = {}) {
  if (access.staff) return;

  const bodyAccountId = accountId != null ? String(accountId).trim() : '';
  const bodyEmail = email ? String(email).trim().toLowerCase() : '';
  const deny = () => {
    throw new PaddleAccessError('Os dados do link não correspondem à sua conta', {
      status: 403,
      code: 'EMAIL_ID_MISMATCH'
    });
  };

  if (bodyAccountId && bodyAccountId !== access.accountId) {
    console.warn(
      `[idor:body_account] session_account=${access.accountId} body_account=${bodyAccountId}`
    );
    deny();
  }
  if (bodyEmail && access.email && bodyEmail !== access.email) {
    console.warn(`[idor:body_email] session_account=${access.accountId}`);
    deny();
  }
}

async function paddleGet(path, paddleToken) {
  try {
    const response = await fetch(`${PADDLE_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${paddleToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/** Customers Paddle que pertencem ao e-mail canonico da conta Leona. */
async function ownedCustomerIds(access, paddleToken) {
  if (!access.email) return new Set();
  const data = await paddleGet(
    `/customers?email=${encodeURIComponent(access.email)}&per_page=50`,
    paddleToken
  );
  const customers = Array.isArray(data) ? data : [];
  return new Set(customers.map(customer => customer?.id).filter(Boolean));
}

function stampedAccountId(resource) {
  const raw =
    resource?.custom_data?.leona_account_id ?? resource?.custom_data?.account_id;
  return raw == null ? null : String(raw).trim();
}

async function assertOwnership(access, resource, paddleToken, logLabel) {
  if (!resource) throw notOwnerError();

  // custom_data e escrito pelo nosso proprio backend nos checkouts, entao
  // vale como vinculo mesmo quando o e-mail divergiu entre Leona e Paddle.
  if (stampedAccountId(resource) === access.accountId) return resource;

  const owned = await ownedCustomerIds(access, paddleToken);
  if (resource.customer_id && owned.has(resource.customer_id)) return resource;

  console.warn(
    `[idor:not_owner] ${logLabel}=${resource.id || '?'} session_account=${access.accountId}`
  );
  throw notOwnerError();
}

export async function assertOwnsSubscription(access, subscriptionId, { paddleToken }) {
  const id = String(subscriptionId || '').trim();
  if (!id) {
    throw new PaddleAccessError('subscription_id é obrigatório', {
      status: 400,
      code: 'MISSING_SUBSCRIPTION_ID'
    });
  }
  if (access.staff) return null;
  const subscription = await paddleGet(
    `/subscriptions/${encodeURIComponent(id)}`,
    paddleToken
  );
  return assertOwnership(access, subscription, paddleToken, 'subscription');
}

export async function assertOwnsTransaction(access, transactionId, { paddleToken }) {
  const id = String(transactionId || '').trim();
  if (!id) {
    throw new PaddleAccessError('transaction_id é obrigatório', {
      status: 400,
      code: 'MISSING_TRANSACTION_ID'
    });
  }
  if (access.staff) return null;
  const transaction = await paddleGet(
    `/transactions/${encodeURIComponent(id)}`,
    paddleToken
  );
  return assertOwnership(access, transaction, paddleToken, 'transaction');
}
