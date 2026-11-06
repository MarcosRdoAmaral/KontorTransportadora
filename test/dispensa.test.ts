import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('retenção de até R$ 10,00 é dispensada (PCC somado, IRRF isolado) e não acumula', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-disp-'));
  Object.assign(process.env, { DATABASE_PATH: path.join(tmp, 'd.db'), STORAGE_DIR: tmp, MASTER_KEY: crypto.randomBytes(32).toString('base64'), SESSION_SECRET: 'x', NFSE_DESKTOP: '1' });
  const { dispensarRetencoes } = await import('../src/servicos/emissao.js');
  // PIS 0,65 + COFINS 3 + CSLL 1 sobre R$ 200 = 1,30 + 6,00 + 2,00 = 9,30 → dispensa as três
  assert.deepEqual(dispensarRetencoes({ pis: 1.3, cofins: 6, csll: 2, irrf: 3 }), { pis: null, cofins: null, csll: null, irrf: null });
  // exatamente R$ 10,00 também é dispensado ("igual ou inferior")
  assert.equal(dispensarRetencoes({ pis: 1.4, cofins: 6.45, csll: 2.15, irrf: null }).pis, null);
  // acima de R$ 10,00 retém as três; o IRRF é avaliado à parte
  const r = dispensarRetencoes({ pis: 3.25, cofins: 15, csll: 5, irrf: 7.5 });
  assert.deepEqual(r, { pis: 3.25, cofins: 15, csll: 5, irrf: null });
  assert.equal(dispensarRetencoes({ pis: 0, cofins: 0, csll: 0, irrf: 10.01 }).irrf, 10.01);
});
