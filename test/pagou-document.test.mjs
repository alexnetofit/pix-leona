import test from 'node:test';
import assert from 'node:assert/strict';

import { customerDocumentOf, customerWritePayload, extractPix, toPagouDocument } from '../lib/pagou.js';

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

test('grava o cliente no contrato oficial da Pagou', () => {
  const body = customerWritePayload({
    name: 'Ednalva Soares',
    email: 'edinha.francisco@gmail.com',
    document: { type: 'CPF', number: '852.008.674-87' },
    phone: '21989908565',
    externalRef: 'leona:4330',
    address: {
      street: 'Avenida Paulista',
      number: '1000',
      street_number: '1000',
      neighborhood: 'Bela Vista',
      city: 'Sao Paulo',
      state: 'SP',
      zipCode: '01310-100',
      zip_code: '01310100',
      country: 'BR'
    },
    ip: '1.2.3.4'
  });
  assert.deepEqual(body.document, { type: 'CPF', number: '85200867487' });
  assert.equal(body.phone, '21989908565');
  assert.equal(body.externalRef, 'leona:4330');
  assert.equal(body.external_id, undefined);
  assert.deepEqual(body.address, {
    street: 'Avenida Paulista',
    number: '1000',
    neighborhood: 'Bela Vista',
    city: 'Sao Paulo',
    state: 'SP',
    zipCode: '01310100',
    country: 'BR'
  });
  assert.equal(body.address.street_number, undefined);
  assert.equal(body.address.zip_code, undefined);
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
