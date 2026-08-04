import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRILHA_DEMO_EMAIL,
  isTrilhaDemoAccess,
  TRILHA_DEMO_PROFILE
} from '../lib/trilha-access.js';

test('demo exige id 1234 e email teste123@gmail.com', () => {
  assert.equal(isTrilhaDemoAccess('1234', TRILHA_DEMO_EMAIL), true);
  assert.equal(isTrilhaDemoAccess('1234', 'outro@gmail.com'), false);
  assert.equal(isTrilhaDemoAccess('999', TRILHA_DEMO_EMAIL), false);
});

test('perfil demo usa email teste', () => {
  assert.equal(TRILHA_DEMO_PROFILE.user.email, 'teste123@gmail.com');
});
