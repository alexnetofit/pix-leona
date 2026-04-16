/**
 * leona-search.js - Proxy de consulta à API de integração do Leona
 *
 * GET /api/leona-search?email=<email>
 *
 * Autenticação: header `Authorization: Bearer <LEONA_LOOKUP_TOKEN>`
 *
 * Camada extra para o time consultar dados de uma conta Leona pelo e-mail
 * sem precisar distribuir o LEONA_BILLING_TOKEN.
 */

const LEONA_BASE = 'https://apiaws.leonasolutions.io/api/v1/integration';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const lookupToken = process.env.LEONA_LOOKUP_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!lookupToken) {
    console.error('leona-search: LEONA_LOOKUP_TOKEN não configurado');
    return res.status(500).json({ error: 'Configuração incompleta (LEONA_LOOKUP_TOKEN)' });
  }

  if (!leonaToken) {
    console.error('leona-search: LEONA_BILLING_TOKEN não configurado');
    return res.status(500).json({ error: 'Configuração incompleta (LEONA_BILLING_TOKEN)' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const providedToken = match ? match[1].trim() : null;

  if (!providedToken || providedToken !== lookupToken) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const email = (req.query?.email || '').toString().trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'Parâmetro "email" é obrigatório' });
  }

  const leonaHeaders = {
    'Authorization': `Bearer ${leonaToken}`,
    'Accept': 'application/json'
  };

  try {
    const r = await fetch(
      `${LEONA_BASE}/accounts/billing_profile?email=${encodeURIComponent(email)}`,
      { headers: leonaHeaders }
    );

    if (r.ok) {
      const profile = await r.json();
      return res.status(200).json({ found: true, profiles: [profile] });
    }

    if (r.status === 409) {
      const conflict = await r.json().catch(() => ({}));
      const ids = Array.isArray(conflict.account_ids) ? conflict.account_ids : [];

      if (ids.length === 0) {
        return res.status(200).json({
          found: false,
          profiles: [],
          error: 'Múltiplas contas encontradas, mas sem IDs retornados pelo Leona'
        });
      }

      const profiles = await Promise.all(ids.map(async (accId) => {
        try {
          const pr = await fetch(
            `${LEONA_BASE}/accounts/${accId}/billing_profile`,
            { headers: leonaHeaders }
          );
          if (pr.ok) return await pr.json();
        } catch (_) {}
        return null;
      }));

      const valid = profiles.filter(Boolean);
      return res.status(200).json({
        found: valid.length > 0,
        profiles: valid
      });
    }

    if (r.status === 404) {
      return res.status(200).json({ found: false, profiles: [] });
    }

    const errBody = await r.json().catch(() => ({}));
    console.error(`leona-search: erro upstream (${r.status}):`, JSON.stringify(errBody));
    return res.status(502).json({
      error: 'Erro ao consultar Leona',
      upstream_status: r.status,
      upstream_error: errBody.error || null
    });

  } catch (error) {
    console.error('leona-search error:', error);
    return res.status(500).json({ error: error.message });
  }
}
