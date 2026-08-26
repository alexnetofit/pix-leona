const PONTOHUB_BASE = 'https://api.grupopontohub.com';

export function pontohubConfigured() {
  return Boolean((process.env.PONTO_HUB_API_KEY || '').trim());
}

async function pontohubRequest(method, path, body) {
  const key = (process.env.PONTO_HUB_API_KEY || '').trim();
  const r = await fetch(`${PONTOHUB_BASE}${path}`, {
    method,
    headers: {
      'X-API-Key': key,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: json };
}

export async function createPontohubLinkRequest(payload) {
  return pontohubRequest('POST', '/api/v1/link-requests', payload);
}

export async function approvePontohubLinkRequest(id, payload = {}) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pontohubRequest('PUT', `/api/v1/link-requests/${encodeURIComponent(id)}/approve`, payload);
}

export async function lookupCep(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.erro) return null;
    return body;
  } catch {
    return null;
  }
}

export function buildPontohubPlayer({ name, email, document, phone, cep, address }, viaCep = null) {
  const digits = String(phone || '').replace(/\D/g, '');
  const phoneNumber = digits.startsWith('55') && digits.length >= 12 ? digits.slice(-11) : digits;
  const street = String(viaCep?.logradouro || '').trim();
  const numberMatch = String(address || '').match(/\b(\d+[A-Za-z\-]?)\b/);
  return {
    name,
    email,
    document: String(document || '').replace(/\D/g, ''),
    phone: phoneNumber,
    address: {
      cep: String(cep || '').replace(/\D/g, ''),
      street: street || String(address || 'Endereço informado').slice(0, 120),
      number: numberMatch?.[1] || 's/n',
      complement: street ? String(address || '').slice(0, 80) : '',
      neighborhood: String(viaCep?.bairro || 'Centro').slice(0, 60),
      city: String(viaCep?.localidade || 'Sao Paulo').slice(0, 60),
      state: String(viaCep?.uf || 'SP').slice(0, 2).toUpperCase()
    }
  };
}
