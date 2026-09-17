import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRILHA_100K_GROUP_JID,
  groupHasPhone,
  interpretGroupAdd,
  normalizeWhatsappNumber,
  trilha100kGroupConfig,
  trilha100kHelpMessage,
  trilha100kHelpUrl
} from '../lib/trilha-100k-group.js';

test('normaliza WhatsApp BR com e sem DDI', () => {
  assert.deepEqual(normalizeWhatsappNumber('11 98784-6444'), { ok: true, phone: '5511987846444' });
  assert.deepEqual(normalizeWhatsappNumber('+55 (11) 98784-6444'), { ok: true, phone: '5511987846444' });
  assert.deepEqual(normalizeWhatsappNumber('5511987846444'), { ok: true, phone: '5511987846444' });
  assert.equal(normalizeWhatsappNumber('').ok, false);
  assert.equal(normalizeWhatsappNumber('123').ok, false);
});

test('mensagem e link de ajuda usam o e-mail do user', () => {
  const email = 'teste123@gmail.com';
  assert.equal(
    trilha100kHelpMessage(email),
    'Preciso de ajuda para entrar no Grupo de 100k. Email: teste123@gmail.com'
  );
  const url = trilha100kHelpUrl(email);
  assert.match(url, /^https:\/\/wa\.me\/5511987846444\?text=/);
  assert.match(url, /teste123%40gmail.com/);
});

test('config aceita URL colada com /instance/', () => {
  const cfg = trilha100kGroupConfig({
    TRILHA_100K_UAZAPI_URL: 'https://leona16.uazapi.com//instance/r264a0b63bcb0eb',
    TRILHA_100K_UAZAPI_TOKEN: 'tok',
    TRILHA_100K_GROUP_JID: DEFAULT_TRILHA_100K_GROUP_JID
  });
  assert.equal(cfg.url, 'https://leona16.uazapi.com');
  assert.equal(cfg.token, 'tok');
});

test('detecta se o número já está no grupo', () => {
  const group = {
    Participants: [{ PhoneNumber: '5511987846444@s.whatsapp.net' }]
  };
  assert.equal(groupHasPhone(group, '5511987846444'), true);
  assert.equal(groupHasPhone(group, '5511999999999'), false);
});

test('add sem HTTP ok devolve o motivo da API', () => {
  const result = interpretGroupAdd({
    httpOk: false,
    payload: { error: 'not-authorized' },
    phone: '5511987846444'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-authorized');
});

test('add 200 só confirma se o número entrou', () => {
  const ok = interpretGroupAdd({
    httpOk: true,
    payload: {},
    phone: '5511987846444',
    groupAfter: { Participants: [{ PN: '5511987846444@s.whatsapp.net' }] }
  });
  assert.equal(ok.ok, true);

  const fail = interpretGroupAdd({
    httpOk: true,
    payload: {},
    phone: '5511987846444',
    groupAfter: { Participants: [] }
  });
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /não confirmou/i);
});
