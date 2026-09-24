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

test('o código invisível fica no meio da frase', () => {
  const url = new URL(buildWaUrl('T2'));
  assert.equal(url.origin + url.pathname, 'https://wa.me/5521966169943');
  const text = url.searchParams.get('text');
  const invisible = encodeInvisible('T2');
  const before = 'Olá, gostaria de ';
  const after = 'receber as receitas';
  assert.equal(text.startsWith(before), true);
  assert.equal(text.endsWith(after), true);
  assert.equal(text.slice(before.length, before.length + invisible.length), invisible);
  assert.equal(text.length, before.length + invisible.length + after.length);
});
