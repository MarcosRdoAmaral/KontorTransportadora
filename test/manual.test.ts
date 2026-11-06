import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// O manual (Relatórios > Documentação) precisa acompanhar a versão publicada: ao subir a versão,
// revise os tópicos em public/manual.js e atualize MANUAL_VERSAO.
test('manual do usuário está na versão do sistema e tem os tópicos principais', async () => {
  const { MANUAL, MANUAL_VERSAO } = await import('../public/manual.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(MANUAL_VERSAO, pkg.version);
  const ids = MANUAL.map((t: any) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids únicos');
  for (const id of ['primeiros-passos', 'empresas', 'emitir', 'notas', 'cobrancas', 'extrato', 'relatorios', 'configuracoes']) assert.ok(ids.includes(id), id);
  for (const t of MANUAL) assert.ok(t.titulo && t.resumo && t.corpo.length > 80, t.id);
});
