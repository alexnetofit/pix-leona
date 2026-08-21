import test from 'node:test';
import assert from 'node:assert/strict';

import { customerDocumentOf, extractPix, toPagouDocument } from '../lib/pagou.js';

test('lê o documento no formato que a Pagou grava', () => {
  assert.deepEqual(customerDocumentOf({
    document: { document_type: 'CPF', document_number: '094.736.739-06' }
  }), { type: 'CPF', number: '09473673906' });
});

test('aceita type/number e infere CPF pelo tamanho', () => {
  assert.deepEqual(toPagouDocument({ type: 'CPF', number: '11311569430' }), {
    type: 'CPF',
    number: '11311569430'
  });
  assert.deepEqual(toPagouDocument('11.333.444/0001-81'), {
    type: 'CNPJ',
    number: '11333444000181'
  });
});

test('rejeita documento incompleto', () => {
  assert.equal(customerDocumentOf({ document: { document_type: 'CPF' } }), null);
  assert.equal(toPagouDocument('123'), null);
});

test('lê QR do PIX automático em authorization', () => {
  assert.equal(extractPix({
    authorization: {
      type: 'pix_qr',
      qr_code: '00020101021226810014br.gov.bcb.pix',
      payment_link_url: 'https://woovi.com/pay/x',
      expires_at: null
    }
  }).qr_code, '00020101021226810014br.gov.bcb.pix');
});
