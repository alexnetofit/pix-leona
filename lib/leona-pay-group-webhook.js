/**
 * Registro do webhook business.approved que abre o grupo do Leona Pay.
 */

const EMAIL_KEYS = ['email', 'Email', 'e-mail', 'mail'];

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function pickEmail(source) {
  const obj = asObject(source);
  if (!obj) return null;
  for (const key of EMAIL_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.includes('@')) return value.trim().toLowerCase().slice(0, 320);
  }
  for (const nested of [obj.owner, obj.business, obj.contact, obj.customer, obj.lead, obj.client, obj.data, obj.payload]) {
    const found = pickEmail(nested);
    if (found) return found;
  }
  return null;
}

export function leonaPayWebhookRecord(body, { contentType = null, query = {}, group = null } = {}) {
  const payload = asObject(body) || { raw: body ?? null };
  return {
    action: 'leona_pay_group_webhook',
    provider: 'leona-pay',
    email: pickEmail(payload),
    account_id: null,
    details: {
      content_type: contentType || null,
      query: asObject(query) || {},
      body: payload,
      group: group || null
    }
  };
}
