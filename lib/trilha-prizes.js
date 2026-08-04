/** Metas e prêmios da Trilha Leona (faturamento acumulado). */

export const TRILHA_MOCK_REVENUE = {
  '1234': 267_000
};

export const TRILHA_PRIZES = [
  {
    id: '10k',
    milestone: 10_000,
    label: 'R$ 10 mil',
    title: 'Carta + Pulseira',
    image: '/trilha/trilha-10k.png',
    items: ['Carta comemorativa', 'Pulseira Leona'],
    priceCents: 1990,
    shippingLabel: 'Somente frete',
    freeShipping: false
  },
  {
    id: '100k',
    milestone: 100_000,
    label: 'R$ 100 mil',
    title: 'Kit Placa Premium',
    image: '/trilha/trilha-100k.png',
    items: [
      'Placa Premium',
      'Pin 10k + Pin 100k (para grudar na placa)',
      'Carta comemorativa'
    ],
    priceCents: 29900,
    shippingLabel: 'Frete grátis',
    freeShipping: true
  },
  {
    id: '250k',
    milestone: 250_000,
    label: 'R$ 250 mil',
    title: 'Pin 250k + Carta',
    image: '/trilha/trilha-250k.png',
    items: ['Pin 250k', 'Carta comemorativa'],
    priceCents: 1990,
    shippingLabel: 'Somente frete',
    freeShipping: false
  },
  {
    id: '500k',
    milestone: 500_000,
    label: 'R$ 500 mil',
    title: 'Pin 500k + Carta',
    image: '/trilha/trilha-500k.png',
    items: ['Pin 500k', 'Carta comemorativa'],
    priceCents: 1990,
    shippingLabel: 'Somente frete',
    freeShipping: false
  },
  {
    id: '1m',
    milestone: 1_000_000,
    label: 'R$ 1 milhão',
    title: 'Pin 1M + Carta',
    image: '/trilha/trilha-1m.png',
    items: ['Pin 1M', 'Carta comemorativa'],
    priceCents: 1990,
    shippingLabel: 'Somente frete',
    freeShipping: false
  },
  {
    id: '2m',
    milestone: 2_000_000,
    label: 'R$ 2 milhões',
    title: 'Pin 2M + Carta',
    image: '/trilha/trilha-2m.png',
    items: ['Pin 2M', 'Carta comemorativa'],
    priceCents: 1990,
    shippingLabel: 'Somente frete',
    freeShipping: false
  }
];

export function resolveTrilhaRevenue(accountId, profileRevenue) {
  const key = String(accountId || '').trim();
  if (key && Object.prototype.hasOwnProperty.call(TRILHA_MOCK_REVENUE, key)) {
    return { value: TRILHA_MOCK_REVENUE[key], source: 'mock' };
  }
  if (typeof profileRevenue === 'number' && Number.isFinite(profileRevenue)) {
    return { value: profileRevenue, source: 'api' };
  }
  return { value: 0, source: 'none' };
}

export function buildTrilhaPayload({ accountId, profile, revenueValue, revenueSource }) {
  const revenue = Math.max(0, Number(revenueValue) || 0);

  const prizes = TRILHA_PRIZES.map((prize) => {
    const unlocked = revenue >= prize.milestone;
    return {
      ...prize,
      priceFormatted: formatBrl(prize.priceCents / 100),
      unlocked,
      status: unlocked ? 'available' : 'locked'
    };
  });

  const unlockedCount = prizes.filter((p) => p.unlocked).length;
  const next = TRILHA_PRIZES.find((p) => p.milestone > revenue) || null;

  return {
    account_id: String(accountId),
    user: profile?.user
      ? {
          name: profile.user.name || null,
          email: profile.user.email || null
        }
      : null,
    plan: profile?.plan_summary || null,
    subscription_status: profile?.subscription_status || null,
    revenue: {
      value: revenue,
      formatted: formatRevenueDisplay(revenue),
      source: revenueSource,
      next_milestone: next
        ? { id: next.id, label: next.label, milestone: next.milestone, remaining: next.milestone - revenue }
        : null
    },
    prizes,
    summary: {
      unlocked: unlockedCount,
      total: prizes.length
    }
  };
}

export function formatBrl(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatRevenueDisplay(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) {
    const mil = n / 1_000_000;
    return mil >= 10
      ? `R$ ${mil.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
      : `R$ ${mil.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  }
  if (n >= 1_000) {
    return `R$ ${Math.round(n / 1_000).toLocaleString('pt-BR')} mil`;
  }
  return formatBrl(n);
}
