/** Catálogo Ponto Hub da Trilha — productId + productName (id compartilhado exige os dois). */

const SHARED_PIN_ID = '3b9cf5b1-d5b2-4967-bacc-5466304b6320';

export const PONTOHUB_PRODUCTS = {
  '50k': {
    productId: '9f6202ed-2c9a-4fd1-8567-a42e741f36fc',
    productName: 'Kit Pulseira Leona + Carta + Envelope',
    sharedId: false
  },
  '100k': {
    productId: 'c24fc253-90e6-40bf-a843-d42d07653bf9',
    productName: 'Placa Trilha do Predador + Pin 100k + Carta + Box',
    sharedId: false
  },
  '250k': {
    productId: SHARED_PIN_ID,
    productName: 'Premiação - Pin 250k + Carta',
    sharedId: true
  },
  '500k': {
    productId: SHARED_PIN_ID,
    productName: 'Premiação - Pin 500k + Carta',
    sharedId: true
  },
  '1m': {
    productId: SHARED_PIN_ID,
    productName: 'Premiação - Pin 1M + Carta',
    sharedId: true
  },
  '2m': {
    productId: SHARED_PIN_ID,
    productName: 'Premiação - Pin 2M + Carta',
    sharedId: true
  },
  garrafa: {
    productId: SHARED_PIN_ID,
    productName: 'Garrafa Squeeze Leona',
    sharedId: true
  },
  jaqueta: {
    productId: '3089dcef-dfff-488e-af0c-9bd4f6d55102',
    productName: 'Jaqueta Preta Personalizada',
    sharedId: false
  }
};

function line(code, qty) {
  const product = PONTOHUB_PRODUCTS[code];
  if (!product || qty <= 0) return [];
  return Array.from({ length: qty }, (_, index) => ({
    code,
    index,
    productId: product.productId,
    productName: product.productName
  }));
}

export function buildPontohubFulfillmentLines({ prizeId, extraQty = 0, bumps = {} } = {}) {
  const extras = Math.max(0, Number(extraQty) || 0);
  const lines = [
    ...line(prizeId, 1),
    ...line(prizeId, extras)
  ];
  for (const [bumpId, qty] of Object.entries(bumps || {})) {
    lines.push(...line(bumpId, Number(qty) || 0));
  }
  return lines;
}
