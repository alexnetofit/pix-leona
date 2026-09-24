/**
 * Redirect de teste: abre o WhatsApp com a frase visível e um código
 * invisível (U+200B / U+200C / U+200D) para ver se a uazapi recebe.
 *
 * GET /tracking?code=T1
 */

const DEST_PHONE = '5521966169943';
const VISIBLE = 'Olá, gostaria de receber as receitas';

export function encodeInvisible(code) {
  const bits = [...String(code)].map((ch) => ch.charCodeAt(0).toString(2).padStart(8, '0')).join('');
  const body = [...bits].map((bit) => (bit === '1' ? '\u200c' : '\u200b')).join('');
  return `\u200d${body}\u200d`;
}

export function buildWaUrl(code) {
  const text = `${VISIBLE}${encodeInvisible(code)}`;
  return `https://wa.me/${DEST_PHONE}?text=${encodeURIComponent(text)}`;
}

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }
  const raw = String(req.query?.code || 'T1');
  const code = raw.replace(/[^\x20-\x7e]/g, '').slice(0, 8) || 'T1';
  const url = buildWaUrl(code);
  res.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store'
  });
  res.end();
}
