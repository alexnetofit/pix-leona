import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextLeonaRecheckAt,
  pickLeonaEmailsToLookup,
  resolveExtraActiveLeonaAccounts
} from '../lib/leona-account-cache.js';
import { lookupLeonaAccountsByEmail } from '../lib/leona.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function profile(id, endIso, status = 'active') {
  return { account_id: id, subscription_status: status, current_period_end: endIso };
}

function harness({ cache = new Map(), lookups = {}, readError = null } = {}) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    options: {
      leonaToken: 'tok',
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
        return lookups[email] || { ok: true, profiles: [] };
      }
    }
  };
}

test('nextLeonaRecheckAt: uma conta volta em 24h + sorteio', () => {
  const one = [profile(1, '2026-12-01T00:00:00Z')];
  assert.equal(nextLeonaRecheckAt(one, { now: NOW, random: () => 0 }).getTime(), NOW + 24 * HOUR);
  assert.equal(nextLeonaRecheckAt([], { now: NOW, random: () => 0.5 }).getTime(), NOW + 27 * HOUR);
});

test('nextLeonaRecheckAt: duas contas voltam logo depois do vencimento mais próximo', () => {
  const soon = [profile(1, '2026-11-04T15:00:00Z'), profile(2, '2026-12-20T00:00:00Z')];
  assert.equal(
    nextLeonaRecheckAt(soon, { now: NOW }).getTime(),
    Date.parse('2026-11-04T15:05:00Z')
  );
  const far = [profile(1, '2026-12-01T00:00:00Z'), profile(2, '2026-12-20T00:00:00Z')];
  assert.equal(nextLeonaRecheckAt(far, { now: NOW }).getTime(), NOW + 12 * HOUR);
  const imminent = [profile(1, '2026-11-04T12:01:00Z'), profile(2, '2026-12-20T00:00:00Z')];
  assert.equal(nextLeonaRecheckAt(imminent, { now: NOW }).getTime(), NOW + 15 * 60 * 1000);
});

test('pickLeonaEmailsToLookup: novos primeiro, depois vencidos mais antigos, com teto', () => {
  const cache = new Map([
    ['fresh@x.com', { recheck_at: new Date(NOW + HOUR).toISOString() }],
    ['old@x.com', { recheck_at: new Date(NOW - 10 * HOUR).toISOString() }],
    ['older@x.com', { recheck_at: new Date(NOW - 20 * HOUR).toISOString() }]
  ]);
  const plan = pickLeonaEmailsToLookup(
    ['fresh@x.com', 'old@x.com', 'new@x.com', 'older@x.com'],
    cache,
    { now: NOW, max: 2 }
  );
  assert.deepEqual(plan.lookup, ['new@x.com', 'older@x.com']);
  assert.equal(plan.missing, 1);
  assert.equal(plan.expired, 2);
  assert.equal(plan.deferred, 1);
});

test('cache válido: nenhuma chamada na Leona e extras vêm do cache', async () => {
  const cache = new Map([
    ['dono@x.com', { active_count: 3, account_ids: ['1', '2', '3'], recheck_at: new Date(NOW + HOUR).toISOString() }],
    ['um@x.com', { active_count: 1, account_ids: ['9'], recheck_at: new Date(NOW + HOUR).toISOString() }]
  ]);
  const h = harness({ cache });
  const { extras, stats } = await resolveExtraActiveLeonaAccounts(['Dono@x.com', 'um@x.com'], h.options);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(extras, [{ email: 'dono@x.com', extra: 2, accountIds: ['1', '2', '3'] }]);
  assert.equal(stats.looked_up, 0);
});

test('e-mail novo é consultado uma vez e gravado com as contas ativas', async () => {
  const h = harness({
    lookups: {
      'novo@x.com': {
        ok: true,
        profiles: [
          profile(10, '2026-12-01T00:00:00Z'),
          profile(11, '2026-12-10T00:00:00Z'),
          profile(12, '2026-10-01T00:00:00Z', 'canceled')
        ]
      }
    }
  });
  const { extras } = await resolveExtraActiveLeonaAccounts(['novo@x.com'], h.options);
  assert.deepEqual(h.calls, ['novo@x.com']);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].account_ids, ['10', '11']);
  assert.equal(h.writes[0].active_count, 2);
  assert.equal(h.writes[0].profiles_count, 3);
  assert.equal(h.writes[0].last_error, null);
  assert.deepEqual(extras, [{ email: 'novo@x.com', extra: 1, accountIds: ['10', '11'] }]);
});

test('erro da Leona mantém o valor antigo e tenta de novo em 15 min', async () => {
  const cache = new Map([
    ['dono@x.com', { active_count: 2, account_ids: ['1', '2'], checked_at: '2026-11-03T00:00:00Z', recheck_at: new Date(NOW - HOUR).toISOString() }]
  ]);
  const h = harness({ cache, lookups: { 'dono@x.com': { ok: false, error: 'HTTP 502' } } });
  const { extras, stats } = await resolveExtraActiveLeonaAccounts(['dono@x.com'], h.options);
  assert.equal(stats.errors, 1);
  assert.equal(h.writes[0].active_count, 2);
  assert.equal(h.writes[0].last_error, 'HTTP 502');
  assert.equal(h.writes[0].recheck_at, new Date(NOW + 15 * 60 * 1000).toISOString());
  assert.deepEqual(extras, [{ email: 'dono@x.com', extra: 1, accountIds: ['1', '2'] }]);
});

test('teto por rodada: 3.000 e-mails novos geram no máximo 250 consultas', async () => {
  const emails = Array.from({ length: 3000 }, (_, i) => `c${i}@x.com`);
  const h = harness();
  const { stats } = await resolveExtraActiveLeonaAccounts(emails, h.options);
  assert.equal(h.calls.length, 250);
  assert.equal(stats.deferred, 2750);
});

test('sem tabela (leitura falha): não consulta a Leona', async () => {
  const h = harness({ readError: new Error('sbSelectWhere leona_email_accounts falhou (404)') });
  const { extras, stats } = await resolveExtraActiveLeonaAccounts(['a@x.com', 'b@x.com'], h.options);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(extras, []);
  assert.equal(stats.cache, 'unavailable');
});

test('gravação falhando não derruba a rodada', async () => {
  const h = harness({
    lookups: { 'a@x.com': { ok: true, profiles: [profile(1, '2026-12-01T00:00:00Z'), profile(2, '2026-12-02T00:00:00Z')] } }
  });
  h.options.writeCache = async () => { throw new Error('boom'); };
  const { extras, stats } = await resolveExtraActiveLeonaAccounts(['a@x.com'], h.options);
  assert.equal(stats.write_failed, true);
  assert.equal(extras.length, 1);
});

test('lookupLeonaAccountsByEmail: 404 é "sem conta", 500 é erro, 409 busca cada conta', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['User-Agent']);
    const u = String(url);
    if (u.includes('email=sem')) return { ok: false, status: 404, json: async () => ({}) };
    if (u.includes('email=falha')) return { ok: false, status: 500, json: async () => ({}) };
    if (u.includes('email=dois')) return { ok: false, status: 409, json: async () => ({ account_ids: [1, 2] }) };
    if (u.includes('/accounts/1/')) return { ok: true, status: 200, json: async () => profile(1, '2099-01-01T00:00:00Z') };
    if (u.includes('/accounts/2/')) return { ok: true, status: 200, json: async () => profile(2, '2099-01-01T00:00:00Z') };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const opts = { fetchImpl, userAgent: 'pix-leona-revenue' };
  assert.deepEqual(await lookupLeonaAccountsByEmail('sem@x.com', 'tok', opts), { ok: true, profiles: [] });
  assert.deepEqual(await lookupLeonaAccountsByEmail('falha@x.com', 'tok', opts), { ok: false, error: 'HTTP 500' });
  const both = await lookupLeonaAccountsByEmail('dois@x.com', 'tok', opts);
  assert.equal(both.ok, true);
  assert.equal(both.profiles.length, 2);
  assert.ok(seen.every((ua) => ua === 'pix-leona-revenue'));
});
