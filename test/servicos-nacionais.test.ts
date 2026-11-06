import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tabela: { c: string; i: string; t: string }[] = JSON.parse(readFileSync(new URL('../public/servicos-nacionais.json', import.meta.url), 'utf8'));

test('lista nacional de serviços: 338 códigos únicos de 6 dígitos', () => {
  assert.equal(tabela.length, 338);
  assert.equal(new Set(tabela.map((o) => o.c)).size, 338);
  for (const o of tabela) { assert.match(o.c, /^\d{6}$/); assert.ok(o.t.length > 3); }
});

test('contabilidade = 171901 (item 17.19)', () => {
  const o = tabela.find((x) => x.c === '171901');
  assert.equal(o?.i, '17.19');
  assert.match(o!.t, /Contabilidade/);
});
