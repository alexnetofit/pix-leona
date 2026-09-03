const PONTOHUB_BASE = 'https://api.grupopontohub.com';

export function pontohubConfigured() {
  return Boolean((process.env.PONTO_HUB_API_KEY || '').trim());
}

async function pontohubRequest(method, path, body) {
  const key = (process.env.PONTO_HUB_API_KEY || '').trim();
  const headers = {
    'X-API-Key': key,
    Accept: 'application/json'
  };
  if (body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${PONTOHUB_BASE}${path}`, {
    method,
    headers,
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

export async function getPontohubLinkRequest(id) {
  if (!id) return { ok: false, status: 400, body: {} };
  return pontohubRequest('GET', `/api/v1/link-requests/${encodeURIComponent(id)}`);
}

export async function updatePontohubLinkAddress(id, address) {
  if (!id) return { ok: false, status: 400, body: { error: 'id ausente' } };
  const payload = {
    cep: String(address.cep || '').replace(/\D/g, ''),
    street: String(address.street || '').trim(),
    number: String(address.number || '').trim(),
    complement: String(address.complement || '').trim(),
    neighborhood: String(address.neighborhood || '').trim(),
    city: String(address.city || '').trim(),
    state: String(address.state || '').trim().toUpperCase().slice(0, 2)
  };
  const first = await pontohubRequest('PUT', `/api/v1/link-requests/${encodeURIComponent(id)}/address`, payload);
  if (first.ok || first.status !== 404) return first;
  return pontohubRequest('PUT', `/api/v1/link-requests/${encodeURIComponent(id)}/address`, { address: payload });
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

export function formatTrilhaAddress(parts = {}) {
  const street = String(parts.street || '').trim();
  const number = String(parts.number || '').trim();
  const complement = String(parts.complement || '').trim();
  const neighborhood = String(parts.neighborhood || '').trim();
  const city = String(parts.city || '').trim();
  const state = String(parts.state || '').trim().toUpperCase();
  return [
    street,
    number ? `nº ${number}` : '',
    complement,
    neighborhood,
    city && state ? `${city} — ${state}` : (city || state)
  ].filter(Boolean).join(', ');
}

export function buildPontohubPlayer({
  name,
  email,
  document,
  phone,
  cep,
  address,
  street,
  number,
  complement,
  neighborhood,
  city,
  state
} = {}, viaCep = null) {
  const digits = String(phone || '').replace(/\D/g, '');
  const phoneNumber = digits.startsWith('55') && digits.length >= 12 ? digits.slice(-11) : digits;
  const shipping = {
    street: String(street || viaCep?.logradouro || address || 'Endereço informado').trim().slice(0, 120),
    number: String(number || 's/n').trim().slice(0, 20),
    complement: String(complement || '').trim().slice(0, 80),
    neighborhood: String(neighborhood || viaCep?.bairro || 'Centro').trim().slice(0, 60),
    city: String(city || viaCep?.localidade || 'Sao Paulo').trim().slice(0, 60),
    state: String(state || viaCep?.uf || 'SP').trim().slice(0, 2).toUpperCase()
  };
  return {
    name,
    email,
    document: String(document || '').replace(/\D/g, ''),
    phone: phoneNumber,
    address: {
      cep: String(cep || '').replace(/\D/g, ''),
      ...shipping
    }
  };
}
