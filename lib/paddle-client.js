function paddleBase() {
  const environment = String(process.env.PADDLE_ENVIRONMENT || '').toLowerCase();
  if (environment === 'sandbox') return 'https://sandbox-api.paddle.com';
  if (['production', 'live'].includes(environment)) return 'https://api.paddle.com';
  throw new Error('PADDLE_ENVIRONMENT deve ser sandbox ou production');
}

function apiKey(explicit) {
  const value = explicit || process.env.PADDLE_API_KEY;
  if (!value) throw new Error('PADDLE_API_KEY não configurado');
  return value;
}

export function paddleHeaders(token) {
  return {
    Authorization: `Bearer ${apiKey(token)}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

export async function paddleRequest(path, options = {}) {
  const { token, ...fetchOptions } = options;
  const response = await fetch(`${paddleBase()}${path}`, {
    ...fetchOptions,
    headers: {
      ...paddleHeaders(token),
      ...(fetchOptions.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  const requestId = body?.meta?.request_id || response.headers.get('request-id') || null;
  if (!response.ok) {
    const error = new Error(
      body?.error?.detail ||
      body?.error?.type ||
      body?.message ||
      `Paddle HTTP ${response.status}`
    );
    error.status = response.status;
    error.body = body;
    error.requestId = requestId;
    throw error;
  }
  return { data: body?.data ?? body, meta: body?.meta || null, requestId };
}

export async function getCustomer(customerId) {
  return (await paddleRequest(`/customers/${encodeURIComponent(customerId)}`)).data;
}

export async function listCustomersByEmail(email) {
  const result = await paddleRequest(`/customers?email=${encodeURIComponent(email)}&per_page=50`);
  return Array.isArray(result.data) ? result.data : [];
}

export async function createCustomer({ email, name, customData }) {
  return (await paddleRequest('/customers', {
    method: 'POST',
    body: JSON.stringify({
      email,
      ...(name ? { name } : {}),
      ...(customData ? { custom_data: customData } : {})
    })
  })).data;
}

export async function updateCustomer(customerId, patch) {
  return (await paddleRequest(`/customers/${encodeURIComponent(customerId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })).data;
}

export async function listSubscriptionsByCustomer(customerId) {
  const result = await paddleRequest(
    `/subscriptions?customer_id=${encodeURIComponent(customerId)}&per_page=100`
  );
  return Array.isArray(result.data) ? result.data : [];
}

export async function getSubscription(subscriptionId) {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`)).data;
}

export async function updateSubscription(subscriptionId, patch) {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })).data;
}

export async function previewSubscriptionUpdate(subscriptionId, patch) {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/preview`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })).data;
}

export async function cancelSubscription(subscriptionId, effectiveFrom = 'next_billing_period') {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ effective_from: effectiveFrom })
  })).data;
}

export async function pauseSubscription(subscriptionId, effectiveFrom = 'next_billing_period') {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ effective_from: effectiveFrom })
  })).data;
}

export async function resumeSubscription(subscriptionId) {
  return (await paddleRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ effective_from: 'immediately' })
  })).data;
}

export async function listProducts({ includePrices = true, status = 'active' } = {}) {
  const qs = new URLSearchParams({ per_page: '200', status });
  if (includePrices) qs.set('include', 'prices');
  const result = await paddleRequest(`/products?${qs}`);
  return Array.isArray(result.data) ? result.data : [];
}

export async function createTransaction(body) {
  return (await paddleRequest('/transactions', {
    method: 'POST',
    body: JSON.stringify(body)
  })).data;
}

export async function createDiscount(body) {
  return (await paddleRequest('/discounts', {
    method: 'POST',
    body: JSON.stringify(body)
  })).data;
}

export async function getTransaction(transactionId, includeAdjustments = false) {
  const suffix = includeAdjustments ? '?include=adjustments' : '';
  return (await paddleRequest(
    `/transactions/${encodeURIComponent(transactionId)}${suffix}`
  )).data;
}

export async function listTransactions(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const suffix = params.size ? `?${params.toString()}` : '';
  const result = await paddleRequest(`/transactions${suffix}`);
  return Array.isArray(result.data) ? result.data : [];
}

export async function createRefundAdjustment({
  transactionId,
  reason,
  items,
  customData
}) {
  return (await paddleRequest('/adjustments', {
    method: 'POST',
    body: JSON.stringify({
      action: 'refund',
      transaction_id: transactionId,
      reason,
      items,
      ...(customData ? { custom_data: customData } : {})
    })
  })).data;
}

export async function generateCustomerAuthToken(customerId) {
  return (await paddleRequest(
    `/customers/${encodeURIComponent(customerId)}/auth-token`,
    { method: 'POST', body: '{}' }
  )).data;
}
