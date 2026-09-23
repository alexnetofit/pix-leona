import test from 'node:test';
import assert from 'node:assert/strict';

import { leonaProfileQuantity, leonaTokenAdjustmentBody } from '../lib/leona.js';

test('quantidade do plano ignora a lista de conexões', () => {
  assert.equal(leonaProfileQuantity({
    starter_instances: 2,
    instances: [{ id: 10, name: 'Loja', phone_number: '5511999990000' }]
  }), 2);
  assert.equal(leonaProfileQuantity({
    instances: [{ id: 10, name: 'Loja', phone_number: null }]
  }), 0);
});

test('corpo de tokens só aceita add/remove e amount positivo', () => {
  assert.deepEqual(leonaTokenAdjustmentBody({
    action: 'add',
    amount: '75.5',
    note: 'crédito comercial'
  }), { body: { action: 'add', amount: 75.5, note: 'crédito comercial' } });
  assert.equal(leonaTokenAdjustmentBody({ action: 'transfer', amount: 10 }).error, 'action inválida. Use add ou remove.');
  assert.equal(leonaTokenAdjustmentBody({ action: 'remove', amount: 0 }).error, 'amount deve ser positivo');
  assert.equal(leonaTokenAdjustmentBody({ action: 'add', amount: 'abc' }).error, 'amount inválido');
  assert.equal('amount_units' in leonaTokenAdjustmentBody({ action: 'add', amount: 1 }).body, false);
});
