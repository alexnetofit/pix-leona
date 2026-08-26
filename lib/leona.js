/**
 * lib/leona.js - Helpers compartilhados para chamar a API de integração do Leona.
 *
 * Usado por api/paddle-subscription.js e api/webhook-paddle.js para que a
 * lógica de lookup por email (com tratamento de 409) e atualização de
 * billing_profile fique num único lugar.
 */

export const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

export function leonaHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

export async function findLeonaAccountByEmail(email, leonaToken) {
  if (!email || !leonaToken) return null;
  const headers = leonaHeaders(leonaToken);

  try {
    const r = await fetch(
      `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      { headers }
    );

    if (r.ok) {
      const profile = await r.json();
      return { account_id: profile.account_id, profile };
    }

    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];
      if (ids.length === 0) return null;

      const profiles = await Promise.all(ids.map(async (id) => {
        try {
          const pr = await fetch(`${LEONA_BASE}/accounts/${id}/billing_profile`, { headers });
          if (pr.ok) return await pr.json();
        } catch (_) {}
        return null;
      }));

      const valid = profiles.filter(Boolean);
      if (valid.length === 1) return { account_id: valid[0].account_id, profile: valid[0] };
      const active = valid.filter(p =>
        p.subscription_status === 'active' &&
        p.current_period_end &&
        new Date(p.current_period_end) > new Date()
      );

      if (active.length === 1) return { account_id: active[0].account_id, profile: active[0] };
      const inactive = valid.filter(p => String(p.subscription_status || '') !== 'active');
      if (inactive.length === 1) return { account_id: inactive[0].account_id, profile: inactive[0] };
      return null;
    }
  } catch (e) {
    console.error('findLeonaAccountByEmail: erro:', e.message);
  }
  return null;
}

export async function updateLeonaBillingProfile(accountId, payload, leonaToken) {
  if (!accountId || !leonaToken) return { ok: false, error: 'sem accountId/token' };

  const headers = leonaHeaders(leonaToken);
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${accountId}/billing_profile`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function getLeonaBillingProfile(accountId, leonaToken) {
  if (!accountId || !leonaToken) return null;
  const url = `${LEONA_BASE}/accounts/${encodeURIComponent(accountId)}/billing_profile`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: leonaHeaders(leonaToken) });
      if (r.ok) return await r.json();
      console.error('getLeonaBillingProfile:', r.status, accountId);
      if (r.status === 404 || attempt === 1 || r.status < 500) return null;
    } catch (e) {
      console.error('getLeonaBillingProfile: erro:', e.message);
      if (attempt === 1) return null;
    }
  }
  return null;
}

/**
 * Match principal pelo ID. E-mail só entra se o ID não achar a conta.
 */
export async function resolveLeonaAccount({ accountId, email, leonaToken } = {}) {
  const id = accountId != null ? String(accountId).trim() : '';
  if (id) {
    const profile = await getLeonaBillingProfile(id, leonaToken);
    if (profile) {
      return {
        account_id: String(profile.account_id ?? id),
        profile,
        source: 'id'
      };
    }
  }

  const emailNorm = email ? String(email).trim().toLowerCase() : '';
  if (!emailNorm) return null;
  const found = await findLeonaAccountByEmail(emailNorm, leonaToken);
  if (!found?.account_id) return null;
  return {
    account_id: String(found.account_id),
    profile: found.profile,
    source: 'email'
  };
}

/** Soma de todas as vendas da conta. Cache ~2 min no servidor Leona. */
export async function getLeonaLifetimeRevenue(accountId, leonaToken) {
  if (!accountId || !leonaToken) return null;
  try {
    const r = await fetch(`${LEONA_BASE}/accounts/${encodeURIComponent(accountId)}/lifetime_revenue`, {
      headers: leonaHeaders(leonaToken)
    });
    if (r.ok) return await r.json();
  } catch (e) {
    console.error('getLeonaLifetimeRevenue: erro:', e.message);
  }
  return null;
}

/**
 * Validacao anti-IDOR centralizada pra qualquer endpoint que aceite
 * `account_id` vindo do cliente final (links do Leona, etc).
 *
 * Regras:
 *   - account_id numerico (legado, enumeravel) -> exige email + match
 *     com o profile do dono.
 *   - account_id UUID (inadivinhavel) -> passa direto, com defesa em
 *     profundidade: se vier email junto, ainda assim exige match.
 *
 * Uso tipico:
 *   const access = await assertAccountAccess({
 *     accountId, queryEmail, leonaToken, route: '/api/foo'
 *   });
 *   if (!access.ok) return res.status(access.status).json(access.body);
 *   const { profile, profileEmail } = access;
 *   // ... segue a logica do endpoint usando o profile ja validado
 *
 * Retorna sempre 403 com code: 'EMAIL_ID_MISMATCH' nos casos de bloqueio
 * (mismatch, conta nao encontrada com email, ou ID legado sem email),
 * pra impedir enumeracao binaria de IDs validos. Logs distinguem os
 * casos com tags [idor:*] pra observabilidade interna.
 */
export async function assertAccountAccess({ accountId, queryEmail, leonaToken, route }) {
  const accountIdRaw = accountId != null ? String(accountId).trim() : '';
  if (!accountIdRaw) {
    return { ok: false, status: 400, body: { error: 'account_id obrigatorio' } };
  }

  const isLegacyNumericId = /^\d+$/.test(accountIdRaw);
  const queryEmailNorm = queryEmail ? String(queryEmail).trim().toLowerCase() : '';
  const tag = route || 'unknown';
  const denyBody = {
    error: 'forbidden',
    code: 'EMAIL_ID_MISMATCH',
    message: 'os dados do link nao correspondem'
  };

  if (isLegacyNumericId && !queryEmailNorm) {
    console.warn(`[idor:legacy_no_email] ${tag} account_id=${accountIdRaw}`);
    return { ok: false, status: 403, body: denyBody };
  }

  const profile = await getLeonaBillingProfile(accountIdRaw, leonaToken);
  const profileEmail = profile?.user?.email
    ? String(profile.user.email).trim().toLowerCase()
    : null;

  if (!profile) {
    if (queryEmailNorm) {
      console.warn(`[idor:notfound] ${tag} account_id=${accountIdRaw} queryEmail=${queryEmailNorm}`);
      return { ok: false, status: 403, body: denyBody };
    }
    return { ok: false, status: 404, body: { error: `conta ${accountIdRaw} nao encontrada` } };
  }

  if (queryEmailNorm && profileEmail && queryEmailNorm !== profileEmail) {
    console.warn(`[idor:mismatch] ${tag} account_id=${accountIdRaw} queryEmail=${queryEmailNorm} profileEmail=${profileEmail}`);
    return { ok: false, status: 403, body: denyBody };
  }

  return { ok: true, profile, profileEmail };
}
