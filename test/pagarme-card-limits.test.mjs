import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGARME_CARD_MAX_ATTEMPTS_PER_DAY,
  PAGARME_CARD_MAX_DISTINCT_PER_DAY,
  pagarmeCardFingerprint,
  pagarmeCardLimitMessage,
  startOfDaySaoPaulo,
  summarizePagarmeCardUsage
} from '../lib/pagarme-card-limits.js';

function charge({ at, last4, first = '411111', method = 'credit_card' }) {
  return {
    payment_method: method,
    created_at: at,
    last_transaction: {
      card: { brand: 'Visa', first_six_digits: first, last_four_digits: last4 }
    }
  };
}

test('teto do dia é 8 tentativas e 5 cartões', () => {
  assert.equal(PAGARME_CARD_MAX_ATTEMPTS_PER_DAY, 8);
  assert.equal(PAGARME_CARD_MAX_DISTINCT_PER_DAY, 5);
});

test('início do dia em São Paulo', () => {
  const start = startOfDaySaoPaulo(new Date('2026-09-06T16:00:00-03:00'));
  assert.equal(start.toISOString(), '2026-09-06T03:00:00.000Z');
});

test('7 tentativas e 5 cartões ainda passam; 8ª tentativa ou 6º cartão fecha o dia', () => {
  const now = new Date('2026-09-06T16:00:00-03:00');
  const rows = [
    charge({ at: '2026-09-06T12:00:00Z', last4: '0001' }),
    charge({ at: '2026-09-06T12:01:00Z', last4: '0002' }),
    charge({ at: '2026-09-06T12:02:00Z', last4: '0003' }),
    charge({ at: '2026-09-06T12:03:00Z', last4: '0004' }),
    charge({ at: '2026-09-06T12:04:00Z', last4: '0005' }),
    charge({ at: '2026-09-06T12:05:00Z', last4: '0001' }),
    charge({ at: '2026-09-06T12:06:00Z', last4: '0002' })
  ];
  const ok = summarizePagarmeCardUsage(rows, { now });
  assert.equal(ok.attempts, 7);
  assert.equal(ok.distinctCards, 5);
  assert.equal(ok.allowed, true);

  const eight = summarizePagarmeCardUsage([
    ...rows,
    charge({ at: '2026-09-06T12:07:00Z', last4: '0003' })
  ], { now });
  assert.equal(eight.attempts, 8);
  assert.equal(eight.allowed, false);

  const sixCards = summarizePagarmeCardUsage([
    ...rows.slice(0, 5),
    charge({ at: '2026-09-06T12:08:00Z', last4: '0006' })
  ], { now });
  assert.equal(sixCards.distinctCards, 6);
  assert.equal(sixCards.allowed, false);
});

test('PIX e cobrança de ontem não entram na conta', () => {
  const now = new Date('2026-09-06T16:00:00-03:00');
  const usage = summarizePagarmeCardUsage([
    charge({ at: '2026-09-05T23:00:00Z', last4: '1111' }),
    { payment_method: 'pix', created_at: '2026-09-06T12:00:00Z' },
    charge({ at: '2026-09-06T12:00:00Z', last4: '2222' })
  ], { now });
  assert.equal(usage.attempts, 1);
  assert.equal(usage.distinctCards, 1);
  assert.equal(usage.allowed, true);
});

test('fingerprint ignora cobrança sem cartão', () => {
  assert.equal(pagarmeCardFingerprint({ payment_method: 'credit_card' }), null);
  assert.equal(
    pagarmeCardFingerprint(charge({ at: '2026-09-06T12:00:00Z', last4: '9999' })),
    'visa|411111|9999'
  );
});

test('mensagem manda pagar no PIX', () => {
  assert.match(pagarmeCardLimitMessage({ attempts: 8, distinctCards: 5 }), /PIX/i);
});
