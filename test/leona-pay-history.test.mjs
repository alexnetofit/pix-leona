import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeonaPayBoard, historyTokenMatches, nextQueueLabel } from '../lib/leona-pay-history.js';
import { LEONA_PAY_HISTORY_PAGE } from '../lib/leona-pay-history-page.js';

const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';

function queueRow(action, details, createdAt = '2026-10-26T16:00:00.000Z') {
  return {
    id: details.payload.business.id,
    action,
    email: details.payload.owner.email,
    account_id: details.payload.business.id,
    created_at: createdAt,
    details
  };
}

function approved(id, name, email) {
  return {
    event: 'business.approved',
    business: {
      id,
      tradeName: 'Loja ' + name,
      legalName: name + ' LTDA',
      taxId: '12345678000199',
      country: 'BR',
      createdAt: '2026-10-20T12:00:00.000Z',
      address: { street: 'Rua A', city: 'São Paulo' }
    },
    owner: { name, email, phone: '5511999998888' }
  };
}

test('o token errado não abre a página', () => {
  assert.equal(historyTokenMatches('curto', SECRET), false);
  assert.equal(historyTokenMatches(SECRET + 'x', SECRET), false);
  assert.equal(historyTokenMatches('', SECRET), false);
  assert.equal(historyTokenMatches(SECRET, ''), false);
  assert.equal(historyTokenMatches(SECRET, SECRET), true);
});

test('o histórico explica sucesso, falha e fila', () => {
  const board = buildLeonaPayBoard({
    now: new Date('2026-10-26T22:00:00.000Z'),
    queueRows: [
      {
        action: 'leona_pay_group_state',
        details: { nextEligibleAt: '2026-10-26T22:10:00.000Z' }
      },
      queueRow('leona_pay_group_done', {
        status: 'done',
        attempts: 1,
        payload: approved('emp-1', 'Ruan Nicolas', 'ruan@example.com'),
        result: { ok: true, groupJid: '120@g.us', groupName: 'Ruan - Leona Pay', leadAdded: true, welcomeSent: true }
      }, '2026-10-24T16:24:00.000Z'),
      queueRow('leona_pay_group_done', {
        status: 'done',
        attempts: 1,
        payload: approved('emp-2', 'Zilda Cavini', 'zilda@example.com'),
        result: { ok: true, groupJid: '121@g.us', leadAdded: false, leadInvited: false, leadReason: 'número não está no WhatsApp' }
      }, '2026-10-24T23:59:00.000Z'),
      queueRow('leona_pay_group_failed', {
        status: 'failed',
        attempts: 3,
        lastError: 'a instância recusou a criação',
        payload: approved('emp-3', 'Diego Santos', 'diego@example.com')
      }, '2026-10-24T17:00:00.000Z'),
      queueRow('leona_pay_group_pending', {
        status: 'pending',
        attempts: 1,
        lastError: 'timeout',
        payload: approved('emp-4', 'Martino Rohling', 'martino@example.com')
      }, '2026-10-24T16:25:00.000Z'),
      queueRow('leona_pay_group_processing', {
        status: 'processing',
        attempts: 1,
        payload: approved('emp-5', 'Gustavo Araujo', 'gustavo@example.com')
      }, '2026-10-24T16:50:00.000Z')
    ],
    webhookRows: [
      {
        id: 'wh-1',
        created_at: '2026-10-26T18:00:00.000Z',
        email: 'ruan@example.com',
        details: { body: approved('emp-1', 'Ruan Nicolas', 'ruan@example.com'), group: { queued: true } }
      },
      {
        id: 'wh-2',
        created_at: '2026-10-23T12:00:00.000Z',
        email: 'antiga@example.com',
        details: {
          body: approved('emp-9', 'Ana Antiga', 'antiga@example.com'),
          group: { ok: false, reason: 'a instância recusou a criação' }
        }
      }
    ]
  });

  const ruan = board.history.find((item) => item.email === 'ruan@example.com');
  const zilda = board.history.find((item) => item.email === 'zilda@example.com');
  const diego = board.history.find((item) => item.email === 'diego@example.com');
  assert.equal(ruan.outcome, 'ok');
  assert.equal(ruan.company.tradeName, 'Loja Ruan Nicolas');
  assert.equal(ruan.company.address, 'Rua A, São Paulo');
  assert.equal(zilda.outcome, 'partial');
  assert.match(zilda.reason, /não está no WhatsApp/);
  assert.equal(diego.outcome, 'failed');
  assert.match(diego.reason, /instância recusou/);
  assert.equal(board.history.filter((item) => item.email === 'ruan@example.com').length, 1);
  assert.equal(board.history.some((item) => item.email === 'antiga@example.com'), true);
  assert.equal(board.counts.queued, 1);
  assert.equal(board.counts.creating, 1);
  assert.equal(board.queue[0].outcome, 'creating');
  assert.equal(board.queue[1].position, 1);
  assert.equal(board.windowOpen, true);
  assert.match(board.nextLabel, /Próximo depois/);
});

test('de madrugada a fila avisa que está parada', () => {
  assert.equal(nextQueueLabel({
    now: new Date('2026-10-26T05:00:00.000Z'),
    windowOpen: false,
    nextEligibleAt: null
  }), 'Parado até 6h');
});

test('a página não traz token e pede os dados na mesma URL', () => {
  assert.equal(LEONA_PAY_HISTORY_PAGE.includes(SECRET), false);
  assert.match(LEONA_PAY_HISTORY_PAGE, /pathname\.replace\(\/\\\/\$\/, ''\) \+ '\/dados'/);
  assert.match(LEONA_PAY_HISTORY_PAGE, /noindex/);
});
