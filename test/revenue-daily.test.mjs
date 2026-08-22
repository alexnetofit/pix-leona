import assert from 'node:assert/strict';
import test from 'node:test';

import { findDaysToSync, findSyncPlan, summarizeRange } from '../lib/revenue-daily.js';
import { daysBetween, shiftDays } from '../lib/revenue-source.js';

function row(day, platform, overrides = {}) {
  return {
    day,
    platform,
    gross_cents: 0,
    net_cents: 0,
    sales_count: 0,
    refund_gross_cents: 0,
    refund_net_cents: 0,
    refund_count: 0,
    transactions_scanned: 0,
    source_pages: 0,
    active_subscribers: null,
    active_subscribers_recurring: null,
    active_subscribers_prepaid: null,
    synced_at: `${day}T12:00:00.000Z`,
    ...overrides
  };
}

test('shiftDays e daysBetween atravessam mês e ano sem escorregar', () => {
  assert.equal(shiftDays('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDays('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(
    daysBetween('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']
  );
  assert.equal(daysBetween('2026-01-01', '2026-12-31', 10).length, 10);
});

test('summarizeRange soma plataformas e converte centavos em reais', () => {
  const rows = [
    row('2026-08-01', 'guru', { gross_cents: 19_700, net_cents: 18_000, sales_count: 1 }),
    row('2026-08-01', 'paddle', { gross_cents: 5_000, net_cents: 4_200, sales_count: 1 }),
    row('2026-08-02', 'guru', {
      gross_cents: 39_400,
      net_cents: 36_000,
      sales_count: 2,
      refund_gross_cents: 19_700,
      refund_net_cents: 18_000,
      refund_count: 1
    }),
    row('2026-08-02', 'paddle'),
    row('2026-08-01', 'pagou', {
      gross_cents: 2_449,
      net_cents: 2_288,
      sales_count: 1,
      transactions_scanned: 12_700
    })
  ];

  const summary = summarizeRange('2026-08-01', '2026-08-02', rows, {
    guru: { count: 40, recurring: null, prepaid: null },
    paddle: { count: 12, recurring: 9, prepaid: 3 },
    pagou: { count: 2, recurring: 0, prepaid: 2 }
  });

  assert.deepEqual(summary.approved, { gross: 768, net: 700.65, count: 5 });
  assert.deepEqual(summary.refunded, { gross: 197, net: 180, count: 1 });
  assert.deepEqual(summary.daily, [
    { day: '2026-08-01', gross: 374 },
    { day: '2026-08-02', gross: 394 }
  ]);
  assert.deepEqual(summary.platforms.guru.approved, { gross: 591, net: 540, count: 3 });
  assert.deepEqual(summary.platforms.paddle.approved, { gross: 50, net: 42, count: 1 });
  assert.equal(summary.active_subscribers.count, 54);
  assert.equal(summary.platforms.paddle.active_subscribers.recurring, 9);
  assert.equal(summary.platforms.pagou.currency, 'BRL');
  assert.deepEqual(summary.platforms.pagou.approved, { gross: 127, net: 118.65, count: 1, brl: 127 });
  assert.equal(summary.days_missing, 0);
});

test('summarizeRange ignora dias fora do intervalo e marca dia sem registro', () => {
  const rows = [
    row('2026-07-31', 'guru', { gross_cents: 100_000, sales_count: 5 }),
    row('2026-08-01', 'guru', { gross_cents: 19_700, sales_count: 1 }),
    row('2026-08-01', 'paddle')
  ];

  const summary = summarizeRange('2026-08-01', '2026-08-03', rows, null);

  assert.deepEqual(summary.approved, { gross: 197, net: 0, count: 1 });
  assert.equal(summary.days_queried, 3);
  assert.equal(summary.days_missing, 2);
  assert.equal(summary.active_subscribers.count, null);
});

test('findDaysToSync cobre dia sem registro, plataforma faltando e dia recente vencido', () => {
  const today = '2026-08-04';
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const days = daysBetween('2026-08-01', today);

  const rows = [
    // Dia antigo completo: nunca precisa voltar pra fonte.
    row('2026-08-01', 'guru'),
    row('2026-08-01', 'paddle'),
    row('2026-08-01', 'pagou'),
    // Dia antigo com uma plataforma faltando.
    row('2026-08-02', 'guru'),
    // Ontem, sincronizado há muito tempo.
    row('2026-08-03', 'guru', { synced_at: old }),
    row('2026-08-03', 'paddle', { synced_at: old }),
    row('2026-08-03', 'pagou', { synced_at: old }),
    // Hoje, recém sincronizado.
    row(today, 'guru', { synced_at: fresh }),
    row(today, 'paddle', { synced_at: fresh }),
    row(today, 'pagou', { synced_at: fresh })
  ];

  assert.deepEqual(
    findDaysToSync(days, rows, { today }),
    ['2026-08-02', '2026-08-03']
  );
});

test('findDaysToSync considera hoje vencido quando o snapshot envelhece', () => {
  const today = '2026-08-04';
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const rows = [
    row(today, 'guru', { synced_at: stale }),
    row(today, 'paddle', { synced_at: stale }),
    row(today, 'pagou', { synced_at: stale })
  ];

  assert.deepEqual(findDaysToSync([today], rows, { today }), [today]);
});

test('findSyncPlan nao manda Guru de volta so porque falta Pagou', () => {
  const today = '2026-08-04';
  const fresh = new Date().toISOString();
  const days = daysBetween('2026-08-01', today);
  const rows = [
    row('2026-08-01', 'guru'),
    row('2026-08-01', 'paddle'),
    row('2026-08-02', 'guru'),
    row('2026-08-02', 'paddle'),
    row('2026-08-03', 'guru', { synced_at: fresh }),
    row('2026-08-03', 'paddle', { synced_at: fresh }),
    row(today, 'guru', { synced_at: fresh }),
    row(today, 'paddle', { synced_at: fresh })
  ];

  const plan = findSyncPlan(days, rows, { today });
  assert.deepEqual(plan.guru, []);
  assert.deepEqual(plan.paddle, []);
  assert.deepEqual(plan.pagou, days);
});
