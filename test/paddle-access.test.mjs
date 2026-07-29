import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PADDLE_SESSION_COOKIE,
  createPaddleSession
} from '../lib/paddle-session.js';
import {
  PaddleAccessError,
  assertBodyIdentityMatches,
  assertOwnsSubscription,
  assertOwnsTransaction,
  isStaffRequest,
  requirePaddleAccess
} from '../lib/paddle-access.js';

const SECRET = 'test-secret-that-is-not-used-in-production';
const STAFF_TOKEN = 'staff-token-only-for-tests';
const PADDLE_TOKEN = 'paddle-token-only-for-tests';
const ACCOUNT_ID = '5239';
const ACCOUNT_EMAIL = 'cliente@example.com';

const originalFetch = globalThis.fetch;

function withEnv(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Roteia fetch por trecho de URL: [[trecho, { status, body }], ...]. */
function stubFetch(routes) {
  globalThis.fetch = async url => {
    const href = String(url);
    const hit = routes.find(([fragment]) => href.includes(fragment));
    const { status = 200, body = {} } = hit ? hit[1] : { status: 404 };
    return { ok: status < 400, status, json: async () => body };
  };
}

function sessionRequest(accountId = ACCOUNT_ID) {
  const token = createPaddleSession({ accountId, secret: SECRET });
  return { headers: { cookie: `${PADDLE_SESSION_COOKIE}=${token}` } };
}

function leonaProfileRoute(email = ACCOUNT_EMAIL) {
  return [
    `/accounts/${ACCOUNT_ID}/billing_profile`,
    { body: { account_id: Number(ACCOUNT_ID), user: { email, name: 'Cliente Teste' } } }
  ];
}

function customersRoute(ids, email = ACCOUNT_EMAIL) {
  return [
    `/customers?email=${encodeURIComponent(email)}`,
    { body: { data: ids.map(id => ({ id, email })) } }
  ];
}

async function accessFor(req, routes) {
  stubFetch(routes);
  return requirePaddleAccess(req, { leonaToken: 'leona-token' });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('token interno vale como staff; token errado ou ausente não', () => {
  withEnv({ TOKEN_ADMIN: STAFF_TOKEN, SUPPORT_CHAT_TOKEN: undefined }, () => {
    assert.equal(isStaffRequest({ headers: { authorization: `Bearer ${STAFF_TOKEN}` } }), true);
    assert.equal(isStaffRequest({ headers: { authorization: 'Bearer errado' } }), false);
    assert.equal(isStaffRequest({ headers: {} }), false);
  });
});

test('sem token e sem cookie de sessão o acesso é negado', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET, TOKEN_ADMIN: STAFF_TOKEN }, async () => {
    await assert.rejects(
      () => requirePaddleAccess({ headers: {} }, { leonaToken: 'leona-token' }),
      error => error instanceof PaddleAccessError && error.status === 401
    );
  });
});

test('sem PADDLE_LINK_SECRET a falha é explícita, não 401 genérico', async () => {
  await withEnv({ PADDLE_LINK_SECRET: undefined, TOKEN_ADMIN: STAFF_TOKEN }, async () => {
    await assert.rejects(
      () => requirePaddleAccess({ headers: {} }, { leonaToken: 'leona-token' }),
      error =>
        error instanceof PaddleAccessError &&
        error.status === 503 &&
        error.code === 'BILLING_SESSION_UNCONFIGURED'
    );
  });
});

test('sessão válida resolve conta e e-mail pelo perfil Leona', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    assert.equal(access.staff, false);
    assert.equal(access.accountId, ACCOUNT_ID);
    assert.equal(access.email, ACCOUNT_EMAIL);
  });
});

test('body não pode contradizer a identidade do cookie', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);

    assert.doesNotThrow(() =>
      assertBodyIdentityMatches(access, { accountId: ACCOUNT_ID, email: ACCOUNT_EMAIL })
    );
    assert.doesNotThrow(() => assertBodyIdentityMatches(access, {}));

    for (const body of [{ accountId: '9999' }, { email: 'outro@example.com' }]) {
      assert.throws(
        () => assertBodyIdentityMatches(access, body),
        error =>
          error instanceof PaddleAccessError &&
          error.status === 403 &&
          error.code === 'EMAIL_ID_MISMATCH'
      );
    }
  });
});

test('staff pode operar conta e e-mail arbitrários', () => {
  const access = { staff: true, accountId: null, profile: null, email: null };
  assert.doesNotThrow(() =>
    assertBodyIdentityMatches(access, { accountId: '1', email: 'qualquer@example.com' })
  );
});

test('assinatura do próprio customer passa no binding', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    stubFetch([
      ['/subscriptions/sub_own', { body: { data: { id: 'sub_own', customer_id: 'ctm_own' } } }],
      customersRoute(['ctm_own'])
    ]);

    const subscription = await assertOwnsSubscription(access, 'sub_own', {
      paddleToken: PADDLE_TOKEN
    });
    assert.equal(subscription.id, 'sub_own');
  });
});

test('assinatura de outro dono é bloqueada', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    stubFetch([
      ['/subscriptions/sub_alheia', { body: { data: { id: 'sub_alheia', customer_id: 'ctm_vitima' } } }],
      customersRoute(['ctm_own'])
    ]);

    await assert.rejects(
      () => assertOwnsSubscription(access, 'sub_alheia', { paddleToken: PADDLE_TOKEN }),
      error =>
        error instanceof PaddleAccessError &&
        error.status === 403 &&
        error.code === 'NOT_OWNER'
    );
  });
});

test('assinatura inexistente responde igual à de outro dono (sem oráculo de enumeração)', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    stubFetch([
      ['/subscriptions/sub_fake', { status: 404, body: { error: { code: 'entity_not_found' } } }],
      customersRoute(['ctm_own'])
    ]);

    await assert.rejects(
      () => assertOwnsSubscription(access, 'sub_fake', { paddleToken: PADDLE_TOKEN }),
      error => error instanceof PaddleAccessError && error.status === 403 && error.code === 'NOT_OWNER'
    );
  });
});

test('custom_data.leona_account_id vale como vínculo quando o e-mail divergiu', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    stubFetch([
      [
        '/subscriptions/sub_stamped',
        {
          body: {
            data: {
              id: 'sub_stamped',
              customer_id: 'ctm_email_antigo',
              custom_data: { leona_account_id: ACCOUNT_ID }
            }
          }
        }
      ],
      customersRoute([])
    ]);

    const subscription = await assertOwnsSubscription(access, 'sub_stamped', {
      paddleToken: PADDLE_TOKEN
    });
    assert.equal(subscription.id, 'sub_stamped');
  });
});

test('transação de outro dono é bloqueada', async () => {
  await withEnv({ PADDLE_LINK_SECRET: SECRET }, async () => {
    const access = await accessFor(sessionRequest(), [leonaProfileRoute()]);
    stubFetch([
      ['/transactions/txn_alheia', { body: { data: { id: 'txn_alheia', customer_id: 'ctm_vitima' } } }],
      customersRoute(['ctm_own'])
    ]);

    await assert.rejects(
      () => assertOwnsTransaction(access, 'txn_alheia', { paddleToken: PADDLE_TOKEN }),
      error => error instanceof PaddleAccessError && error.status === 403
    );
  });
});

test('staff não precisa de binding de recurso', async () => {
  const access = { staff: true, accountId: null, profile: null, email: null };
  assert.equal(await assertOwnsSubscription(access, 'sub_qualquer', { paddleToken: PADDLE_TOKEN }), null);
  assert.equal(await assertOwnsTransaction(access, 'txn_qualquer', { paddleToken: PADDLE_TOKEN }), null);
});

test('id ausente é erro de request, não de autorização', async () => {
  const access = { staff: true, accountId: null, profile: null, email: null };
  await assert.rejects(
    () => assertOwnsSubscription(access, '', { paddleToken: PADDLE_TOKEN }),
    error => error instanceof PaddleAccessError && error.status === 400
  );
});
