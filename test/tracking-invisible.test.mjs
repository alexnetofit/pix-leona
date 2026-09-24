import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWaUrl, encodeInvisible } from '../api/tracking.js';

test('código T1 vira bits invisíveis entre ZWJ', () => {
  const invisible = encodeInvisible('T1');
  const points = [...invisible].map((ch) => ch.codePointAt(0));
  assert.equal(points[0], 0x200d);
  assert.equal(points.at(-1), 0x200d);
  assert.deepEqual(points.slice(1, -1), [
    0x200b, 0x200c, 0x200b, 0x200c, 0x200b, 0x200c, 0x200b, 0x200b,
    0x200b, 0x200b, 0x200c, 0x200c, 0x200b, 0x200b, 0x200b, 0x200c
  ]);
});

test('o link abre o número de teste com a frase visível', () => {
  const url = new URL(buildWaUrl('T1'));
  assert.equal(url.origin + url.pathname, 'https://wa.me/5521966169943');
  const text = url.searchParams.get('text');
  assert.equal(text.startsWith('Olá, gostaria de receber as receitas'), true);
  assert.equal(text.length, 'Olá, gostaria de receber as receitas'.length + encodeInvisible('T1').length);
});
