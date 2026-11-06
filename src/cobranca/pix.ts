/**
 * Pix copia e cola (BR Code, padrão EMV do Banco Central). O Kontor não gera o Pix: o escritório gera a cobrança no
 * banco e cola o código aqui. O código é conferido (formato e dígito CRC) e lido (valor, recebedor, chave) para evitar
 * colar o Pix de outra cobrança.
 */

export interface PixLido { codigo: string; valor: number | null; recebedor: string | null; cidade: string | null; chave: string | null; txid: string | null; dinamico: boolean }

/** CRC16-CCITT (polinômio 0x1021, inicial 0xFFFF), como pede o BR Code. */
export function crc16(texto: string): string {
  let crc = 0xffff;
  for (const b of Buffer.from(texto, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Campos "ID(2) + tamanho(2) + valor". Devolve null se a estrutura não fecha. */
function tlv(s: string): Map<string, string> | null {
  const m = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2), n = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(s.slice(i + 2, i + 4)) || i + 4 + n > s.length) return null;
    m.set(id, s.slice(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return m;
}

export function lerPix(entrada: string): PixLido {
  const codigo = String(entrada ?? '').replace(/[\r\n\t]/g, '').trim();
  if (!codigo) throw new Error('Cole o código do Pix copia e cola.');
  if (!codigo.startsWith('000201')) throw new Error('Isso não parece um Pix copia e cola: o código deve começar com 000201. Copie de novo o código completo no aplicativo do banco.');
  const m = /6304([0-9A-Fa-f]{4})$/.exec(codigo);
  if (!m) throw new Error('O código do Pix está incompleto (falta o final). Copie de novo o código completo.');
  if (crc16(codigo.slice(0, -4)).toUpperCase() !== m[1].toUpperCase()) throw new Error('O código do Pix está incompleto ou foi alterado (o dígito de conferência não bate). Copie de novo o código completo.');
  const campos = tlv(codigo);
  if (!campos) throw new Error('O código do Pix não está no formato do Banco Central. Copie de novo o código completo.');
  const conta = tlv(campos.get('26') ?? '') ?? new Map();
  if (!/^br\.gov\.bcb\.pix$/i.test(conta.get('00') ?? '')) throw new Error('O código não é de um Pix (falta a identificação br.gov.bcb.pix).');
  const adicionais = tlv(campos.get('62') ?? '') ?? new Map();
  const valor = campos.has('54') ? Number(campos.get('54')) : null;
  return {
    codigo, valor: valor != null && Number.isFinite(valor) ? valor : null,
    recebedor: campos.get('59')?.trim() || null, cidade: campos.get('60')?.trim() || null,
    chave: conta.get('01') ?? null, txid: adicionais.get('05') && adicionais.get('05') !== '***' ? adicionais.get('05')! : null,
    dinamico: conta.has('25') || campos.get('01') === '12',
  };
}

/** Monta um BR Code estático (Pix copia e cola com a chave da empresa; também usado nos testes). */
export function montarPix(d: { chave: string; valor?: number; nome: string; cidade: string; txid?: string }): string {
  const f = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  const conta = f('00', 'br.gov.bcb.pix') + f('01', d.chave);
  const corpo = f('00', '01') + f('26', conta) + f('52', '0000') + f('53', '986') + (d.valor ? f('54', d.valor.toFixed(2)) : '') + f('58', 'BR')
    + f('59', d.nome.slice(0, 25)) + f('60', d.cidade.slice(0, 15)) + f('62', f('05', d.txid ?? '***')) + '6304';
  return corpo + crc16(corpo);
}
