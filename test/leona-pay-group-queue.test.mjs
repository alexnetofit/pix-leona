import test from 'node:test';
import assert from 'node:assert/strict';
import { assinaturaLogPurgeFilters } from '../lib/assinatura-log.js';
import { LEONA_PAY_QUEUE_PROVIDER } from '../lib/leona-pay-group-queue.js';
import {
  enqueueLeonaPayGroup,
  leonaPayDelayMs,
  runLeonaPayGroupQueue,
  withinLeonaPaySendWindow
} from '../lib/leona-pay-group-queue.js';

function approved(id, email) {
  return {
    event: 'business.approved',
    business: {
      id,
      tradeName: 'Loja',
      country: 'BR',
      createdAt: '2026-10-26T12:00:00.000Z'
    },
    owner: { name: 'Ana Souza', email }
  };
}

function memoryDb() {
  const rows = [];
  let seq = 1;
  let state = null;
  return {
    rows,
    nextEligibleAt() {
      return state?.details?.nextEligibleAt || null;
    },
    async findOpen({ businessId, email }) {
      return rows.find((row) => {
        const status = row.details?.status;
        if (!['pending', 'processing', 'done'].includes(status)) return false;
        if (businessId) return row.account_id === businessId;
        return row.email === email;
      }) || null;
    },
    async insert({ email, businessId, payload }) {
      const row = {
        id: String(seq++),
        email,
        account_id: businessId,
        details: { status: 'pending', payload, attempts: 0, groupJid: null }
      };
      rows.push(row);
      return row;
    },
    async getState() {
      return state;
    },
    async setNextEligible(date) {
      state = { details: { nextEligibleAt: date.toISOString() } };
    },
    async releaseStale() {},
    async claimNext(now) {
      const row = rows.find((item) => item.details.status === 'pending');
      if (!row) return null;
      row.details = {
        ...row.details,
        status: 'processing',
        attempts: Number(row.details.attempts || 0) + 1,
        lockedAt: now.toISOString()
      };
      return { ...row, details: { ...row.details } };
    },
    async finish(row, { status, result, error, now }) {
      const stored = rows.find((item) => item.id === row.id);
      stored.details = {
        ...row.details,
        status,
        finishedAt: status === 'pending' ? null : now.toISOString(),
        groupJid: result?.groupJid || null,
        result: result || null,
        lastError: error || null
      };
    }
  };
}

function ourClient() {
  return {
    async get() {
      return { httpOk: true, payload: { instance: { owner: '5512991426510' } } };
    }
  };
}

test('a janela é das 6h até meia-noite em Brasília', () => {
  assert.equal(withinLeonaPaySendWindow(new Date('2026-10-26T08:59:00.000Z')), false);
  assert.equal(withinLeonaPaySendWindow(new Date('2026-10-26T09:00:00.000Z')), true);
  assert.equal(withinLeonaPaySendWindow(new Date('2026-10-27T02:59:00.000Z')), true);
  assert.equal(withinLeonaPaySendWindow(new Date('2026-10-27T03:00:00.000Z')), false);
});

test('o intervalo fica entre 5 e 10 minutos', () => {
  assert.equal(leonaPayDelayMs(() => 0), 5 * 60 * 1000);
  assert.equal(leonaPayDelayMs(() => 0.999999), 10 * 60 * 1000);
});

test('vários aceites entram na fila e saem um por vez', async () => {
  const db = memoryDb();
  const first = await enqueueLeonaPayGroup(approved('empresa_a', 'a@loja.com'), { db });
  const again = await enqueueLeonaPayGroup(approved('empresa_a', 'a@loja.com'), { db });
  await enqueueLeonaPayGroup(approved('empresa_b', 'b@loja.com'), { db });
  await enqueueLeonaPayGroup(approved('empresa_c', 'c@loja.com'), { db });
  assert.equal(first.already, false);
  assert.equal(again.already, true);
  assert.equal(db.rows.length, 3);

  const sent = [];
  const create = async (body) => {
    sent.push(body.business.id);
    return { ok: true, groupJid: `${body.business.id}@g.us` };
  };
  const morning = new Date('2026-10-26T13:00:00.000Z');
  const firstRun = await runLeonaPayGroupQueue({
    now: morning,
    random: () => 0,
    db,
    client: ourClient(),
    create,
    lookupPhone: async () => null
  });
  assert.equal(firstRun.action, 'sent');
  assert.deepEqual(sent, ['empresa_a']);

  const tooSoon = await runLeonaPayGroupQueue({
    now: new Date(morning.getTime() + 4 * 60 * 1000),
    random: () => 0,
    db,
    client: ourClient(),
    create,
    lookupPhone: async () => null
  });
  assert.equal(tooSoon.reason, 'intervalo');
  assert.deepEqual(sent, ['empresa_a']);

  const second = await runLeonaPayGroupQueue({
    now: new Date(morning.getTime() + 5 * 60 * 1000),
    random: () => 0,
    db,
    client: ourClient(),
    create,
    lookupPhone: async () => null
  });
  assert.equal(second.action, 'sent');
  assert.deepEqual(sent, ['empresa_a', 'empresa_b']);
  assert.equal(db.rows.filter((row) => row.details.status === 'pending').length, 1);
});

test('de madrugada a fila não envia', async () => {
  const db = memoryDb();
  await enqueueLeonaPayGroup(approved('empresa_a', 'a@loja.com'), { db });
  let called = false;
  const result = await runLeonaPayGroupQueue({
    now: new Date('2026-10-26T05:00:00.000Z'),
    db,
    client: { async get() { called = true; return { httpOk: true, payload: {} }; } },
    create: async () => { throw new Error('não deveria criar'); },
    lookupPhone: async () => null
  });
  assert.equal(result.reason, 'fora do horário');
  assert.equal(called, false);
  assert.equal(db.rows[0].details.status, 'pending');
});

test('não envia se a instância conectada não for a nossa', async () => {
  const db = memoryDb();
  await enqueueLeonaPayGroup(approved('empresa_a', 'a@loja.com'), { db });
  const result = await runLeonaPayGroupQueue({
    now: new Date('2026-10-26T13:00:00.000Z'),
    db,
    client: {
      async get() {
        return { httpOk: true, payload: { instance: { owner: '5521964746924' } } };
      }
    },
    create: async () => { throw new Error('não deveria criar'); },
    lookupPhone: async () => null
  });
  assert.equal(result.reason, 'instância do WhatsApp não é a nossa');
  assert.equal(db.rows[0].details.status, 'pending');
});

test('o purge dos logs não apaga a fila', () => {
  const filters = assinaturaLogPurgeFilters(new Date('2026-10-26T15:00:00.000Z'));
  assert.equal(filters.neq.provider, LEONA_PAY_QUEUE_PROVIDER);
  assert.equal(filters.lt.created_at, '2026-10-24T15:00:00.000Z');
});
