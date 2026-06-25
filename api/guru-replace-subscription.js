/**
 * api/guru-replace-subscription.js — gera link de checkout "alternativo"
 * pra quando o upgrade tradicional da Guru (PUT /subscriptions/:id/plans)
 * fica bloqueado por causa de fatura de renovacao em aberto (current_invoice
 * com status `waiting_payment`). Esse cenario rola tipicamente nos ~2 dias
 * antes da data de renovacao, quando a Guru ja emitiu a fatura do proximo
 * ciclo mas o `payment_url` so funciona no dia da cobranca as 10h (UTC-3).
 *
 * Fluxo (transparente pro cliente):
 *   1. Front chama este endpoint com { account_id, qty, email }.
 *   2. A gente acha a oferta correspondente a `qty` no produto Leona
 *      e devolve o `checkout_url` com `?src=<account_id>&email=<email>`.
 *   3. Cliente paga esse link como se fosse compra nova.
 *   4. webhook-guru.js detecta que a conta `account_id` ja tinha um
 *      `guru_account_id` antigo (diferente do novo) e:
 *        - re-vincula a conta com a nova subscription (firstLink=true)
 *        - cancela a sub Guru antiga automaticamente (ver webhook-guru.js)
 *   5. Cliente nem percebe o cancel/replace — so ve um link funcionando.
 *
 * Este endpoint NAO cancela nada e NAO mexe no Leona. O cancelamento da
 * sub antiga e feito pelo webhook-guru SO depois que o cliente pagar.
 * Isso evita deixar o cliente com Leona "orfa" caso ele desista do link.
 */
import { LEONA_BASE, leonaHeaders, assertAccountAccess } from '../lib/leona.js';
import { GURU_BASE, LEONA_GURU_PRODUCT_ID, guruHeaders } from '../lib/guru.js';
import { applyCors } from '../lib/auth.js';

function pickOfferByQty(offers, qty) {
  if (!Array.isArray(offers)) return null;
  for (const o of offers) {
    if (!o?.is_active) continue;
    const m = String(o?.name || '').match(/(\d+)\s*conex/i);
    if (m && parseInt(m[1], 10) === qty) return o;
  }
  return null;
}

// O produto Leona tem >50 ofertas e a Guru pagina; planos como 8/9 conexoes
// podem ficar fora das primeiras 50, entao paginamos tudo.
async function fetchAllOffers(productId, headers) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const u = new URL(`${GURU_BASE}/products/${productId}/offers`);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u, { headers });
    if (!res.ok) return { ok: false, status: res.status, res };
    const body = await res.json();
    if (Array.isArray(body.data)) all.push(...body.data);
    cursor = body.next_cursor;
    if (!body.has_more_pages || !cursor) break;
  }
  return { ok: true, offers: all };
}

function appendParams(url, params) {
  if (!url) return null;
  const entries = Object.entries(params).filter(([, v]) => v != null && String(v).trim() !== '');
  if (entries.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return url + sep + qs;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const guruToken = process.env.GURU_TOKEN;
  const leonaToken = process.env.LEONA_BILLING_TOKEN;

  if (!guruToken) return res.status(500).json({ error: 'GURU_TOKEN não configurado' });
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });

  const { account_id, qty, email } = req.body || {};

  // account_id aceita int (legado) ou UUID. Tratamos como string opaca.
  const accountId = account_id != null ? String(account_id).trim() : '';
  if (!accountId) {
    return res.status(400).json({ error: 'account_id inválido' });
  }
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum < 1) {
    return res.status(400).json({ error: 'qty deve ser >= 1' });
  }

  // Anti-IDOR: ID numerico legado exige email + match. UUID passa direto.
  const access = await assertAccountAccess({
    accountId,
    queryEmail: email,
    leonaToken,
    route: '/api/guru-replace-subscription'
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const { profile, profileEmail } = access;

  try {
    const checkoutEmail = (typeof email === 'string' && email.trim())
      ? email.trim().toLowerCase()
      : profileEmail;

    const offersResult = await fetchAllOffers(LEONA_GURU_PRODUCT_ID, guruHeaders(guruToken));

    if (!offersResult.ok) {
      const body = await offersResult.res.text().catch(() => '');
      return res.status(502).json({
        error: `Guru retornou ${offersResult.status} ao buscar ofertas`,
        detail: body.slice(0, 500)
      });
    }

    const offers = offersResult.offers;
    const offer = pickOfferByQty(offers, qtyNum);

    if (!offer) {
      return res.status(404).json({
        error: `nenhuma oferta ativa encontrada para ${qtyNum} conexão(ões)`,
        qty: qtyNum
      });
    }

    if (!offer.checkout_url) {
      return res.status(500).json({
        error: `oferta ${offer.id} sem checkout_url configurado`,
        offer_id: offer.id,
        offer_name: offer.name
      });
    }

    const checkoutUrl = appendParams(offer.checkout_url, {
      src: String(accountId),
      email: checkoutEmail
    });

    console.log(
      `guru-replace-subscription: account=${accountId}, qty=${qtyNum}, ` +
      `offer=${offer.id} (${offer.name}), email=${checkoutEmail || '(nenhum)'}, ` +
      `current_guru_id=${profile.guru_account_id || '(nenhum)'}`
    );

    return res.status(200).json({
      success: true,
      checkout_url: checkoutUrl,
      offer_id: offer.id,
      offer_name: offer.name,
      value: offer.value,
      qty: qtyNum,
      account_id: accountId,
      previous_guru_account_id: profile.guru_account_id || null
    });
  } catch (error) {
    console.error('guru-replace-subscription error:', error);
    return res.status(500).json({ error: error.message });
  }
}
