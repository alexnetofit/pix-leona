/**
 * GET /api/dlocal-go-return
 * A Go manda o cliente pra cá depois do checkout de assinatura
 * (?external_id=leona:conta:qty). Libera a Leona e redireciona pro app.
 */
import { processDlocalPaidPayment } from '../lib/dlocal-activate.js';
import { getLeonaBillingProfile } from '../lib/leona.js';
import { parseLeonaRef } from '../lib/leona-pricing.js';
import {
  dlocalGoAppUrl,
  findLatestPaidDlocalPayment,
  getDlocalPayment,
  parseDlocalOrderId
} from '../lib/dlocal-go.js';

function redirectToApp(res) {
  res.writeHead(302, { Location: dlocalGoAppUrl() });
  return res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const query = req.query || {};
  const paymentId = String(query.payment_id || query.id || '').trim();
  const ref = parseLeonaRef(query.external_id)
    || parseDlocalOrderId(query.external_id)
    || parseLeonaRef(`leona:${query.account_id || ''}:${query.qty || ''}`);
  const accountId = ref?.accountId || String(query.account_id || '').trim() || null;
  const qty = ref?.qty || (query.qty ? Number(query.qty) : null);
  let email = String(query.email || '').trim() || null;

  try {
    let payment = null;
    if (/^DP-/i.test(paymentId)) {
      const fetched = await getDlocalPayment(paymentId);
      payment = fetched.body || null;
    }

    if (!payment && accountId && process.env.LEONA_BILLING_TOKEN) {
      const profile = await getLeonaBillingProfile(accountId, process.env.LEONA_BILLING_TOKEN);
      email = email || profile?.user?.email || null;
    }

    if (!payment) {
      payment = await findLatestPaidDlocalPayment({ email, accountId, qty });
    }

    if (payment?.id && process.env.LEONA_BILLING_TOKEN) {
      await processDlocalPaidPayment(payment, { req, source: 'return' });
    }
  } catch (err) {
    console.error('dlocal-go-return:', err.message);
  }

  return redirectToApp(res);
}
