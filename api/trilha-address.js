/**
 * POST /api/trilha-address — troca o endereço enquanto o pedido ainda está no carrinho da fábrica.
 */
import { applyCors } from '../lib/auth.js';
import { logAssinaturaEvent } from '../lib/assinatura-log.js';
import { resolveTrilhaAccess } from '../lib/trilha-access.js';
import { lookupCep } from '../lib/pontohub.js';
import {
  listTrilhaAccountCheckouts,
  normalizeTrilhaAddress,
  updateTrilhaCheckoutAddress
} from '../lib/trilha-fulfill.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const leonaToken = process.env.LEONA_BILLING_TOKEN;
  if (!leonaToken) return res.status(500).json({ error: 'LEONA_BILLING_TOKEN não configurado' });

  const body = req.body || {};
  const access = await resolveTrilhaAccess({
    accountId: body.account_id || body.id,
    email: body.email,
    leonaToken
  });
  if (!access.ok) return res.status(access.status).json(access.body);

  const resolvedAccountId = String(access.profile.account_id ?? body.account_id);
  const orderId = String(body.order_id || body.checkout_id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Pedido ausente' });

  let checkout;
  try {
    checkout = (await listTrilhaAccountCheckouts(resolvedAccountId)).find((row) => String(row.id) === orderId);
  } catch (error) {
    console.error('trilha-address list:', error);
    return res.status(500).json({ error: 'Falha ao ler o pedido' });
  }
  if (!checkout) return res.status(404).json({ error: 'Pedido não encontrado' });

  const viaCep = await lookupCep(body.cep);
  const normalized = normalizeTrilhaAddress({ ...body, viaCep });
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });

  const updated = await updateTrilhaCheckoutAddress(checkout, normalized.address);
  logAssinaturaEvent(req, {
    action: updated.ok ? 'trilha_address_updated' : 'trilha_address_failed',
    provider: 'pontohub',
    email: access.profileEmail,
    account_id: resolvedAccountId,
    details: { order_id: orderId, ...updated }
  });
  if (!updated.ok) return res.status(updated.blocked ? 409 : 502).json({ error: updated.error });
  return res.status(200).json({ ok: true, shipping: updated.shipping });
}
