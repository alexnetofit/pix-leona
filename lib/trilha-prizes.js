/** Metas e prêmios da Trilha Leona (faturamento acumulado). */

export const TRILHA_MOCK_REVENUE = {
  '1234': 267_000
};

export const TRILHA_PRIZES = [
  {
    id: '50k',
    milestone: 50_000,
    label: 'R$ 50 mil',
    title: 'Carta + Pulseira + Pin 50k',
    image: '/trilha/trilha-50k.png',
    items: ['Carta comemorativa', 'Pulseira Leona', 'Pin 50k'],
    prizeFree: true,
    priceCents: 2990,
    shippingLabel: 'Frete: R$ 29,90',
    freeShipping: false,
    extraUnitCents: 6750
  },
  {
    id: '100k',
    milestone: 100_000,
    label: 'R$ 100 mil',
    title: 'Kit Placa Premium',
    image: '/trilha/trilha-100k.png',
    items: [
      'Placa Premium',
      'Pin 100k (para grudar na placa)',
      'Carta comemorativa',
      { text: 'Acesso ao Grupo VIP + Eventos privados futuros', highlight: true }
    ],
    prizeFree: false,
    priceCents: 29700,
    shippingLabel: 'Frete grátis',
    freeShipping: true,
    extraUnitCents: 34650
  },
  {
    id: '250k',
    milestone: 250_000,
    label: 'R$ 250 mil',
    title: 'Pin 250k + Carta',
    image: '/trilha/trilha-250k.png',
    items: ['Pin 250k', 'Carta comemorativa'],
    prizeFree: true,
    priceCents: 2990,
    shippingLabel: 'Frete: R$ 29,90',
    freeShipping: false,
    extraUnitCents: 5450
  },
  {
    id: '500k',
    milestone: 500_000,
    label: 'R$ 500 mil',
    title: 'Pin 500k + Carta',
    image: '/trilha/trilha-500k.png',
    items: ['Pin 500k', 'Carta comemorativa'],
    prizeFree: true,
    priceCents: 2990,
    shippingLabel: 'Frete: R$ 29,90',
    freeShipping: false,
    extraUnitCents: 5450
  },
  {
    id: '1m',
    milestone: 1_000_000,
    label: 'R$ 1 milhão',
    title: 'Pin 1M + Carta',
    image: '/trilha/trilha-1m.png',
    items: ['Pin 1M', 'Carta comemorativa'],
    prizeFree: true,
    priceCents: 2990,
    shippingLabel: 'Frete: R$ 29,90',
    freeShipping: false,
    extraUnitCents: 5450
  },
  {
    id: '2m',
    milestone: 2_000_000,
    label: 'R$ 2 milhões',
    title: 'Pin 2M + Carta',
    image: '/trilha/trilha-2m.png',
    items: ['Pin 2M', 'Carta comemorativa'],
    prizeFree: true,
    priceCents: 2990,
    shippingLabel: 'Frete: R$ 29,90',
    freeShipping: false,
    extraUnitCents: 5450
  }
];

export const TRILHA_ORDER_BUMPS = [
  {
    id: 'garrafa',
    title: 'Garrafa Leona',
    subtitle: 'Alumínio preto fosco · logo branca',
    priceCents: 3750,
    image: '/trilha/bumps/garrafa.png'
  },
  {
    id: 'jaqueta',
    title: 'Jaqueta Leona',
    subtitle: 'Bomber preta premium · logo bordada',
    priceCents: 12650,
    image: '/trilha/bumps/jaqueta.png'
  }
];

export function normalizePrizeItems(items) {
  return (items || []).map((item) => {
    if (item && typeof item === 'object') {
      return { text: String(item.text || ''), highlight: Boolean(item.highlight) };
    }
    return { text: String(item || ''), highlight: false };
  });
}

/** Usa só BRL pra desbloquear marcos. Outras moedas não entram no valor. */
export function pickBrlLifetimeRevenue(payload) {
  const brl = payload?.revenue_by_currency?.BRL;
  if (typeof brl === 'number' && Number.isFinite(brl)) return brl;
  return null;
}

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

export function buildTrilhaPayload({
  accountId,
  profile,
  revenueValue,
  revenueSource,
  redeemEligibility,
  revenueByCurrency = null,
  revenueComputedAt = null
}) {
  const revenue = Math.max(0, Number(revenueValue) || 0);
  const canRedeem = redeemEligibility?.eligible !== false;

  const prizes = TRILHA_PRIZES.map((prize) => {
    const unlocked = revenue >= prize.milestone;
    const prizeFree = Boolean(prize.prizeFree);
    // Placa e itens pagos: basta bater a meta. Frete grátis exige 3 meses.
    let status = 'locked';
    if (unlocked && (!prizeFree || canRedeem)) status = 'available';
    else if (unlocked && !canRedeem) status = 'ineligible';

    return {
      ...prize,
      items: normalizePrizeItems(prize.items),
      prizeFree,
      priceFormatted: prizeFree ? 'GRÁTIS' : formatBrl(prize.priceCents / 100),
      cta: 'Resgatar',
      unlocked,
      redeem_blocked: unlocked && prizeFree && !canRedeem,
      status
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
      by_currency: revenueByCurrency,
      computed_at: revenueComputedAt,
      next_milestone: next
        ? { id: next.id, label: next.label, milestone: next.milestone, remaining: next.milestone - revenue }
        : null
    },
    prizes,
    order_bumps: TRILHA_ORDER_BUMPS,
    summary: {
      unlocked: unlockedCount,
      total: prizes.length
    },
    redeem_eligibility: redeemEligibility || null
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
