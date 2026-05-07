/**
 * webhook-paddle-replay.js — Endpoint de DEBUG/REPROCESSAMENTO.
 *
 * Roda exatamente a mesma logica do /api/webhook-paddle, MAS:
 *  - NAO valida paddle-signature (autentica via SUPPORT_CHAT_TOKEN)
 *  - Retorna o resultado completo (incluindo payload enviado pra Leona)
 *
 * Uso pelo suporte:
 *
 *   curl -X POST https://client.leonaflow.com/api/webhook-paddle-replay \
 *     -H "Authorization: Bearer $SUPPORT_CHAT_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d @evento_paddle.json
 *
 * Util quando o webhook real falhou (entrega 401 por secret errado, ou
 * timeout, etc) e a gente quer reprocessar o evento ja com a logica
 * correta pra liberar o cliente.
 */

import { processPaddleEvent } from './webhook-paddle.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido' });

  const expected = process.env.SUPPORT_CHAT_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'SUPPORT_CHAT_TOKEN nao configurado' });
  }

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (provided !== expected) {
    return res.status(401).json({ error: 'Token invalido' });
  }

  const event = req.body;
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'Body deve ser um JSON de evento Paddle' });
  }

  try {
    const result = await processPaddleEvent(event);
    return res.status(200).json({
      replayed: true,
      event_id: event.event_id || null,
      event_type: event.event_type || null,
      result_status: result.status,
      result_body: result.body
    });
  } catch (e) {
    return res.status(500).json({ replayed: false, error: e.message, stack: e.stack });
  }
}
