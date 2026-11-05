import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupGuruActive,
  nextGuruRecheckAt,
  pickGuruEmailsToLookup,
  resolveGuruOverlapEmails
} from '../lib/guru-email-cache.js';
import { LEONA_GURU_PRODUCT_ID } from '../lib/guru.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function harness({ cache = new Map(), lookups = {}, readError = null } = {}) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    options: {
      guruToken: 'tok',
      now: NOW,
      random: () => 0,
      cacheEnabled: () => true,
      readCache: async () => {
        if (readError) throw readError;
        return new Map(cache);
      },
      writeCache: async (rows) => { writes.push(...rows); },
      lookup: async (email) => {
        calls.push(email);
        return lookups[email] || { ok: true, active: false, cycleEnd: null };
      }
    }
  };
}

test('nextGuruRecheckAt: sem assinatura volta em 24h + sorteio', () => {
  assert.equal(nextGuruRecheckAt(false, null, { now: NOW, random: () => 0 }).getTime(), NOW + 24 * HOUR);
  assert.equal(nextGuruRecheckAt(false, null, { now: NOW, random: () => 0.5 }).getTime(), NOW + 27 * HOUR);
});

test('nextGuruRecheckAt: assinatura ativa volta no fim do ciclo, com teto de 24h', () => {
  const soon = nextGuruRecheckAt(true, '2026-11-04', { now: NOW, random: () => 0 });
  assert.equal(soon.toISOString(), '2026-11-05T03:04:59.000Z');
  assert.equal(nextGuruRecheckAt(true, '2026-12-20', { now: NOW, random: () => 0 }).getTime(), NOW + 24 * HOUR);
  assert.equal(nextGuruRecheckAt(true, '2026-11-01', { now: NOW, random: () => 0 }).getTime(), NOW + 15 * 60 * 1000);
});

test('pickGuruEmailsToLookup: novos primeiro, depois vencidos mais antigos, com teto', () => {
  const cache = new Map([
    ['fresh@x.com', { recheck_at: new Date(NOW + HOUR).toISOString() }],
    ['old@x.com', { recheck_at: new Date(NOW - 10 * HOUR).toISOString() }],
    ['older@x.com', { recheck_at: new Date(NOW - 20 * HOUR).toISOString() }]
  ]);
  const plan = pickGuruEmailsToLookup(
    ['fresh@x.com', 'old@x.com', 'new@x.com', 'older@x.com'],
    cache,
    { now: NOW, max: 2 }
  );
  assert.deepEqual(plan.lookup, ['new@x.com', 'older@x.com']);
  assert.equal(plan.missing, 1);
  assert.equal(plan.expired, 2);
  assert.equal(plan.deferred, 1);
});

test('cache válido: nenhuma chamada na Guru e só o ativo entra no cruzamento', async () => {
  const cache = new Map([
    ['guru@x.com', { active: true, recheck_at: new Date(NOW + HOUR).toISOString() }],
    ['pagarme@x.com', { active: false, recheck_at: new Date(NOW + HOUR).toISOString() }]
  ]);
  const h = harness({ cache });
  const { emails, stats } = await resolveGuruOverlapEmails(['Guru@x.com', 'pagarme@x.com'], h.options);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(emails, ['guru@x.com']);
  assert.equal(stats.looked_up, 0);
  assert.equal(stats.overlap, 1);
});

test('e-mail novo é consultado uma vez e gravado', async () => {
  const h = harness({
    lookups: { 'novo@x.com': { ok: true, active: true, cycleEnd: '2026-12-01' } }
  });
  const { emails } = await resolveGuruOverlapEmails(['novo@x.com'], h.options);
  assert.deepEqual(h.calls, ['novo@x.com']);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].active, true);
  assert.equal(h.writes[0].cycle_end, '2026-12-01');
  assert.equal(h.writes[0].last_error, null);
  assert.deepEqual(emails, ['novo@x.com']);
});

test('erro da Guru mantém o valor antigo e tenta de novo em 15 min', async () => {
  const cache = new Map([
    ['guru@x.com', { active: true, cycle_end: '2026-12-01', checked_at: '2026-11-03T00:00:00Z', recheck_at: new Date(NOW - HOUR).toISOString() }]
  ]);
  const h = harness({ cache, lookups: { 'guru@x.com': { ok: false, error: 'HTTP 429' } } });
  const { emails, stats } = await resolveGuruOverlapEmails(['guru@x.com'], h.options);
  assert.equal(stats.errors, 1);
  assert.equal(h.writes[0].active, true);
  assert.equal(h.writes[0].last_error, 'HTTP 429');
  assert.equal(h.writes[0].recheck_at, new Date(NOW + 15 * 60 * 1000).toISOString());
  assert.deepEqual(emails, ['guru@x.com']);
});

test('teto por rodada: 3.000 e-mails novos geram no máximo 250 consultas', async () => {
  const emails = Array.from({ length: 3000 }, (_, i) => `c${i}@x.com`);
  const h = harness();
  const { stats } = await resolveGuruOverlapEmails(emails, h.options);
  assert.equal(h.calls.length, 250);
  assert.equal(stats.deferred, 2750);
});

test('sem tabela: não consulta a Guru', async () => {
  const h = harness({ readError: new Error('sbSelectWhere guru_email_active falhou (404)') });
  const { emails, stats } = await resolveGuruOverlapEmails(['a@x.com', 'b@x.com'], h.options);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(emails, []);
  assert.equal(stats.cache, 'unavailable');
});

test('gravação falhando não derruba a rodada', async () => {
  const h = harness({
    lookups: { 'a@x.com': { ok: true, active: true, cycleEnd: '2026-12-01' } }
  });
  h.options.writeCache = async () => { throw new Error('boom'); };
  const { emails, stats } = await resolveGuruOverlapEmails(['a@x.com'], h.options);
  assert.equal(stats.write_failed, true);
  assert.deepEqual(emails, ['a@x.com']);
});

test('lookupGuruActive: sem contato é inativo, 429 é erro, assinatura Leona ativa devolve o ciclo', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['User-Agent']);
    const u = String(url);
    if (u.includes('email=sem')) return { ok: true, json: async () => ({ data: [] }) };
    if (u.includes('email=falha')) return { ok: false, status: 429, json: async () => ({}) };
    if (u.includes('email=ativo')) {
      return { ok: true, json: async () => ({ data: [{ id: 'ct_1', email: 'ativo@x.com' }] }) };
    }
    if (u.includes('contact_id=ct_1')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { product: { id: 'outro' }, last_status: 'active', cycle_end_date: '2026-12-01' },
            { product: { id: LEONA_GURU_PRODUCT_ID }, last_status: 'active', cycle_end_date: '2026-11-20' },
            { product: { id: LEONA_GURU_PRODUCT_ID }, last_status: 'canceled', cycle_end_date: '2026-10-01' }
          ]
        })
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  assert.deepEqual(await lookupGuruActive('sem@x.com', 'tok', { fetchImpl }), { ok: true, active: false, cycleEnd: null });
  assert.deepEqual(await lookupGuruActive('falha@x.com', 'tok', { fetchImpl }), { ok: false, error: 'HTTP 429' });
  assert.deepEqual(
    await lookupGuruActive('ativo@x.com', 'tok', { fetchImpl }),
    { ok: true, active: true, cycleEnd: '2026-11-20' }
  );
  assert.ok(seen.every((ua) => ua === 'pix-leona-revenue'));
});
