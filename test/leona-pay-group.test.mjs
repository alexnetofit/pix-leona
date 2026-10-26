import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEONA_PAY_WELCOME_TEXT,
  createLeonaPayGroup,
  leonaPayGroupName,
  leonaPayPrivateInviteText,
  leonaPhoneForEmail,
  normalizeLeadPhone,
  parseApprovedBusiness
} from '../lib/leona-pay-group.js';

const SAMPLE = {
  event: 'business.approved',
  approvedAt: '2026-10-13T20:00:00.000Z',
  business: {
    id: 'empresa_exemplo',
    legalName: 'Loja Exemplo LTDA',
    tradeName: 'Loja Exemplo',
    taxId: '12345678000199',
    country: 'BR',
    status: 'VERIFIED',
    createdAt: '2026-10-01T12:00:00.000Z'
  },
  owner: {
    name: 'Ana Souza',
    email: 'ana@lojaexemplo.com'
  }
};

const ENV = {
  LEONA_PAY_UAZAPI_URL: 'https://uazapi.example',
  LEONA_PAY_UAZAPI_TOKEN: 'tok',
  LEONA_PAY_MAX_PHONE: '5521964746924'
};

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const handler = handlers[path];
      if (!handler) return { httpOk: true, status: 200, payload: {} };
      return handler(body);
    },
    async get(path) {
      calls.push({ path, body: null });
      const handler = handlers[path];
      if (handler) return handler();
      if (path === '/instance/status') {
        return { httpOk: true, status: 200, payload: { instance: { owner: '5512991426510' } } };
      }
      return { httpOk: true, status: 200, payload: {} };
    }
  };
}

test('lê o business.approved e monta o nome do grupo', () => {
  const parsed = parseApprovedBusiness(SAMPLE);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.groupName, 'Ana - Leona Pay');
  assert.equal(parsed.email, 'ana@lojaexemplo.com');
  assert.equal(parsed.businessId, 'empresa_exemplo');
  assert.equal(parsed.phone, null);
  assert.equal(parsed.phoneError, 'payload sem telefone');
  assert.equal(leonaPayGroupName('  THARYK   MAIA '), 'Tharyk - Leona Pay');
});

test('telefone brasileiro curto ganha DDI', () => {
  assert.deepEqual(normalizeLeadPhone('(12) 99999-8888', 'BR'), { ok: true, phone: '5512999998888' });
  assert.deepEqual(normalizeLeadPhone('5512999998888', 'BR'), { ok: true, phone: '5512999998888' });
  const parsed = parseApprovedBusiness({
    ...SAMPLE,
    owner: { ...SAMPLE.owner, phone: '12999998888' }
  });
  assert.equal(parsed.phone, '5512999998888');
});

test('outro evento não abre grupo', () => {
  const parsed = parseApprovedBusiness({ event: 'payment.paid', owner: { name: 'Ana' } });
  assert.equal(parsed.skipped, true);
});

test('cria o grupo com foto, descrição e o Max admin, sem cliente quando não há telefone', async () => {
  const client = fakeClient({
    '/group/list': () => ({ httpOk: true, status: 200, payload: { groups: [] } }),
    '/group/create': (body) => {
      assert.deepEqual(body.participants, ['5521964746924']);
      assert.equal(body.name, 'Ana - Leona Pay');
      return { httpOk: true, status: 200, payload: { group: { JID: '120@g.us' }, failed: [] } };
    },
    '/group/updateDescription': (body) => {
      assert.match(body.description, /Empresa: Loja Exemplo/);
      assert.match(body.description, /E-mail: ana@lojaexemplo.com/);
      assert.match(body.description, /Cliente: Ana Souza/);
      assert.match(body.description, /Criada em: 01\/10\/2026/);
      assert.match(body.description, /client\.leonapay\.com\.br\/login/);
      assert.equal(body.groupjid, '120@g.us');
      return { httpOk: true, status: 200, payload: {} };
    },
    '/group/updateImage': (body) => {
      assert.equal(body.image, 'data:image/jpeg;base64,abc');
      return { httpOk: true, status: 200, payload: {} };
    },
    '/group/updateParticipants': (body) => {
      assert.equal(body.action, 'promote');
      assert.deepEqual(body.participants, ['5521964746924']);
      return { httpOk: true, status: 200, payload: { groupUpdated: [{ JID: '5521964746924@s.whatsapp.net', Error: 0 }] } };
    }
  });

  const result = await createLeonaPayGroup(SAMPLE, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.groupJid, '120@g.us');
  assert.equal(result.maxAdmin, true);
  assert.equal(result.leadAdded, false);
  assert.equal(result.leadReason, 'payload sem telefone');
  assert.equal(result.welcomeSent, false);
  assert.equal(client.calls.some((call) => call.path === '/send/text'), false);
});

test('reaproveita grupo existente e adiciona o cliente', async () => {
  const client = fakeClient({
    '/group/list': () => ({
      httpOk: true,
      status: 200,
      payload: { groups: [{ jid: '999@g.us', name: 'Ana - Leona Pay' }] }
    }),
    '/group/info': () => ({
      httpOk: true,
      status: 200,
      payload: { Topic: 'E-mail: ana@lojaexemplo.com\nID: empresa_exemplo', Participants: [] }
    }),
    '/group/updateParticipants': (body) => {
      if (body.action === 'add') {
        assert.deepEqual(body.participants, ['5512999998888']);
        return { httpOk: true, status: 200, payload: { groupUpdated: [{ JID: '5512999998888@s.whatsapp.net', Error: 0 }] } };
      }
      return { httpOk: true, status: 200, payload: { groupUpdated: [{ JID: '5521964746924@s.whatsapp.net', Error: 0 }] } };
    }
  });

  const result = await createLeonaPayGroup({
    ...SAMPLE,
    owner: { ...SAMPLE.owner, whatsapp: '12 99999-8888' }
  }, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });

  assert.equal(result.created, false);
  assert.equal(result.groupJid, '999@g.us');
  assert.equal(result.leadAdded, true);
  assert.equal(result.welcomeSent, true);
  const welcome = client.calls.find((call) => call.path === '/send/text');
  assert.equal(welcome.body.number, '999@g.us');
  assert.equal(welcome.body.text, LEONA_PAY_WELCOME_TEXT);
  assert.equal(client.calls.some((call) => call.path === '/group/create'), false);
});

test('mesmo primeiro nome de outra empresa abre outro grupo', async () => {
  const client = fakeClient({
    '/group/list': () => ({
      httpOk: true,
      status: 200,
      payload: { groups: [{ jid: '999@g.us', name: 'Ana - Leona Pay' }] }
    }),
    '/group/info': () => ({
      httpOk: true,
      status: 200,
      payload: { Topic: 'E-mail: outra@empresa.com\nID: outra-empresa', Participants: [] }
    }),
    '/group/create': (body) => {
      assert.equal(body.name, 'Ana - Leona Pay');
      return { httpOk: true, status: 200, payload: { group: { JID: 'novo@g.us' }, failed: [] } };
    }
  });

  const result = await createLeonaPayGroup(SAMPLE, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });
  assert.equal(result.created, true);
  assert.equal(result.groupJid, 'novo@g.us');
});

test('privacidade do cliente vira convite', async () => {
  const client = fakeClient({
    '/group/list': () => ({ httpOk: true, status: 200, payload: [] }),
    '/group/create': () => ({
      httpOk: true,
      status: 200,
      payload: { group: { JID: '120@g.us' }, failed: ['5512999998888@s.whatsapp.net'] }
    }),
    '/group/updateParticipants': (body) => {
      if (body.action === 'add') {
        return {
          httpOk: true,
          status: 200,
          payload: {
            groupUpdated: [{
              JID: '5512999998888@s.whatsapp.net',
              Error: 403,
              AddRequest: { Code: 'INVITE', Expiration: '2026-10-20T00:00:00Z' }
            }]
          }
        };
      }
      return { httpOk: true, status: 200, payload: {} };
    },
    '/send/group-invite': (body) => {
      assert.equal(body.number, '5512999998888');
      assert.equal(body.code, 'INVITE');
      return { httpOk: true, status: 200, payload: { messageid: 'm1' } };
    }
  });
  client.get = async (path) => {
    client.calls.push({ path, body: null });
    if (path === '/instance/status') {
      return { httpOk: true, status: 200, payload: { instance: { owner: '5512991426510' } } };
    }
    return { httpOk: true, status: 200, payload: { inviteLink: 'https://chat.whatsapp.com/Abc' } };
  };

  const result = await createLeonaPayGroup({
    ...SAMPLE,
    owner: { ...SAMPLE.owner, phone: '5512999998888' }
  }, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });

  const text = client.calls.find((call) => call.path === '/send/text');
  assert.equal(result.leadAdded, false);
  assert.equal(result.leadInvited, true);
  assert.equal(result.welcomeSent, false);
  assert.equal(text.body.number, '5512999998888');
  assert.equal(text.body.text, leonaPayPrivateInviteText('https://chat.whatsapp.com/Abc'));
  assert.equal(client.calls.some((call) => call.path === '/send/group-invite'), false);
});

test('sem código de convite, manda o link no privado', async () => {
  const client = fakeClient({
    '/group/list': () => ({ httpOk: true, status: 200, payload: [] }),
    '/group/create': () => ({
      httpOk: true,
      status: 200,
      payload: { group: { JID: '120@g.us' }, failed: ['5512999998888@s.whatsapp.net'] }
    }),
    '/group/info': () => ({ httpOk: true, status: 200, payload: { Participants: [] } }),
    '/group/updateParticipants': (body) => {
      if (body.action === 'add') {
        return {
          httpOk: true,
          status: 200,
          payload: { groupUpdated: [{ JID: '5512999998888@s.whatsapp.net', Error: 403, AddRequest: null }] }
        };
      }
      return { httpOk: true, status: 200, payload: {} };
    }
  });
  client.get = async (path) => {
    client.calls.push({ path, body: null });
    if (path === '/instance/status') {
      return { httpOk: true, status: 200, payload: { instance: { owner: '5512991426510' } } };
    }
    assert.equal(path, '/group/invitelink/120%40g.us');
    return { httpOk: true, status: 200, payload: { inviteLink: 'https://chat.whatsapp.com/Abc' } };
  };

  const result = await createLeonaPayGroup({
    ...SAMPLE,
    owner: { ...SAMPLE.owner, phone: '5512999998888' }
  }, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });

  const text = client.calls.find((call) => call.path === '/send/text');
  assert.equal(result.leadInvited, true);
  assert.equal(text.body.text, leonaPayPrivateInviteText('https://chat.whatsapp.com/Abc'));
  assert.equal(text.body.number, '5512999998888');
});

test('sem telefone no payload, usa o da conta Leona', async () => {
  const client = fakeClient({
    '/group/list': () => ({ httpOk: true, status: 200, payload: [] }),
    '/group/create': (body) => {
      assert.equal(body.name, 'Ana - Leona Pay');
      assert.deepEqual(body.participants, ['5521964746924', '5519998224445']);
      return { httpOk: true, status: 200, payload: { group: { JID: '120@g.us' } } };
    },
    '/group/info': () => ({
      httpOk: true,
      status: 200,
      payload: { Participants: [{ JID: '5519998224445@s.whatsapp.net' }] }
    })
  });

  const result = await createLeonaPayGroup(SAMPLE, {
    env: ENV,
    client,
    image: 'data:image/jpeg;base64,abc',
    phone: '+19998224445'
  });

  const welcome = client.calls.find((call) => call.path === '/send/text');
  assert.equal(result.leadAdded, true);
  assert.equal(result.leadReason, null);
  assert.equal(result.welcomeSent, true);
  assert.equal(welcome.body.number, '120@g.us');
  assert.equal(welcome.body.text, LEONA_PAY_WELCOME_TEXT);
  assert.equal(client.calls.some((call) => call.path === '/send/group-invite'), false);
});

test('cliente entrou no grupo, não manda nada no privado', async () => {
  const client = fakeClient({
    '/group/list': () => ({ httpOk: true, status: 200, payload: [] }),
    '/group/create': (body) => {
      assert.deepEqual(body.participants, ['5521964746924', '5511988888261']);
      return { httpOk: true, status: 200, payload: { group: { JID: '120@g.us' }, failed: [] } };
    },
    '/group/info': () => ({
      httpOk: true,
      status: 200,
      payload: { Participants: [{ PhoneNumber: '551188888261', JID: '551188888261@s.whatsapp.net' }] }
    })
  });

  const result = await createLeonaPayGroup({
    ...SAMPLE,
    owner: { ...SAMPLE.owner, phone: '11988888261' }
  }, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });

  const welcome = client.calls.find((call) => call.path === '/send/text');
  assert.equal(result.leadAdded, true);
  assert.equal(result.leadInvited, false);
  assert.equal(result.welcomeSent, true);
  assert.equal(welcome.body.number, '120@g.us');
  assert.equal(client.calls.some((call) => call.path === '/send/group-invite'), false);
  assert.equal(client.calls.filter((call) => call.path === '/send/text').length, 1);
});

test('não cria grupo se a instância conectada não for a nossa', async () => {
  const client = fakeClient({
    '/instance/status': () => ({
      httpOk: true,
      status: 200,
      payload: { instance: { owner: '5521964746924' } }
    }),
    '/group/create': () => {
      throw new Error('não deveria criar');
    }
  });
  const result = await createLeonaPayGroup(SAMPLE, { env: ENV, client, image: 'data:image/jpeg;base64,abc' });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'instance');
  assert.equal(client.calls.some((call) => call.path === '/group/create'), false);
});

test('telefone da Leona prefere a conta ativa', async () => {
  const phone = await leonaPhoneForEmail('ana@lojaexemplo.com', {
    env: { LEONA_BILLING_TOKEN: 'tok' },
    fetchImpl: async (url) => {
      if (String(url).includes('account_ids') || String(url).includes('?email=')) {
        return { status: 409, json: async () => ({ account_ids: [1, 2] }) };
      }
      if (String(url).endsWith('/1/billing_profile')) {
        return { status: 200, json: async () => ({ user: { phone: '+111' }, subscription_status: 'inactive' }) };
      }
      return { status: 200, json: async () => ({ user: { phone: '12999998888' }, subscription_status: 'active' }) };
    }
  });
  assert.equal(phone, '12999998888');
});
