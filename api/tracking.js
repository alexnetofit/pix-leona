/**
 * Redirect de teste: abre o WhatsApp com a frase visível e um código
 * invisível (U+200B / U+200C / U+200D) no meio da frase, para a uazapi receber.
 *
 * GET /tracking?code=T2
 * O código fica entre "Olá, gostaria de " e "receber as receitas".
 */

const DEST_PHONE = '5521966169943';
const BEFORE = 'Olá, gostaria de ';
const AFTER = 'receber as receitas';

export function encodeInvisible(code) {
  const bits = [...String(code)].map((ch) => ch.charCodeAt(0).toString(2).padStart(8, '0')).join('');
  const body = [...bits].map((bit) => (bit === '1' ? '\u200c' : '\u200b')).join('');
  return `\u200d${body}\u200d`;
}

export function buildWaUrl(code) {
  const text = `${BEFORE}${encodeInvisible(code)}${AFTER}`;
  return `https://wa.me/${DEST_PHONE}?text=${encodeURIComponent(text)}`;
}

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }
  const raw = String(req.query?.code || 'T2');
  const code = raw.replace(/[^\x20-\x7e]/g, '').slice(0, 8) || 'T2';
  const url = buildWaUrl(code);
  res.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store'
  });
  res.end();
}
