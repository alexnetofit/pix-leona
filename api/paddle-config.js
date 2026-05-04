/**
 * paddle-config.js - Devolve o client-side token da Paddle para o navegador.
 *
 * O token client-side (formato live_... ou test_...) é DIFERENTE do
 * PADDLE_API_KEY (server-side, apikey_...). Ele é seguro de expor no HTML/JS
 * porque só permite operações limitadas de checkout.
 *
 * Usado por public/recovery.html para inicializar o Paddle.js sem precisar
 * hard-coded.
 */

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    client_token: process.env.PADDLE_CLIENT_TOKEN || null,
    environment: process.env.PADDLE_ENVIRONMENT || 'production'
  });
}
