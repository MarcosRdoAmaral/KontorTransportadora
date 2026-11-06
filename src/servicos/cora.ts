import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { cifrarTexto, decifrarTexto } from '../cofre.js';
import { CoraApi, ErroRedeCora, centavos, reais, VALOR_MINIMO, type CoraCredenciais } from '../cobranca/cora.js';
import { ErroNegocio } from './emissao.js';
import { condicoesDoBoleto, marcarPago, obterCobranca, pendenciasPagador } from './cobranca.js';
import { importarLancamentosExternos } from './extrato.js';

const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const soDig = (s: string) => (s ?? '').replace(/\D/g, '');
const somaDias = (d: string, n: number) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Credenciais da conta Cora (por empresa)
// ---------------------------------------------------------------------------
export const ContaCoraEntrada = z.object({
  ativa: z.boolean().default(true),
  ambiente: z.enum(['teste', 'producao']).default('producao'),
  client_id: z.string().trim().min(4, 'Informe o Client ID').max(120),
  certificado: z.string().trim().max(20000).nullish(),
  chave: z.string().trim().max(20000).nullish(),
  multa_pct: z.number().min(0).max(20).default(2),
  juros_pct_mes: z.number().min(0).max(20).default(1),
});

/** Confere se o certificado e a chave são PEM válidos e formam um par. */
export function conferirPar(certPem: string, chavePem: string) {
  try {
    const cert = new crypto.X509Certificate(certPem);
    const chave = crypto.createPrivateKey(chavePem);
    if (!cert.checkPrivateKey(chave)) throw new Error('par');
  } catch (e: any) {
    if (e.message === 'par') throw new ErroNegocio('A chave privada não pertence a este certificado. Use os dois arquivos gerados juntos na Cora.');
    throw new ErroNegocio('Certificado ou chave inválidos. Cole o texto completo dos arquivos .pem (de "-----BEGIN" até "-----END").');
  }
}

export function contaCoraAtiva(empresaId: number): boolean {
  return !!db.prepare('SELECT 1 FROM contas_cora WHERE empresa_id = ? AND ativa = 1').get(empresaId);
}

/** Dados para a tela: nunca devolve certificado nem chave. */
export function obterContaCora(empresaId: number) {
  const c = db.prepare('SELECT ativa, ambiente, client_id, multa_pct, juros_pct_mes, ultima_sync_pagos, ultima_sync_extrato, saldo, saldo_em FROM contas_cora WHERE empresa_id = ?').get(empresaId) as any;
  return c ? { ...c, ativa: !!c.ativa, tem_credenciais: true } : null;
}

export function salvarContaCora(empresaId: number, d: z.infer<typeof ContaCoraEntrada>) {
  const atual = db.prepare('SELECT cert_enc, chave_enc, ambiente FROM contas_cora WHERE empresa_id = ?').get(empresaId) as any;
  const cert = d.certificado || (atual ? decifrarTexto(atual.cert_enc) : '');
  const chave = d.chave || (atual ? decifrarTexto(atual.chave_enc) : '');
  if (!cert || !chave) throw new ErroNegocio('Informe o certificado e a chave privada da Cora.');
  conferirPar(cert, chave);
  db.prepare(`INSERT INTO contas_cora (empresa_id, ativa, ambiente, client_id, cert_enc, chave_enc, multa_pct, juros_pct_mes)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(empresa_id) DO UPDATE SET ativa=excluded.ativa, ambiente=excluded.ambiente, client_id=excluded.client_id, cert_enc=excluded.cert_enc, chave_enc=excluded.chave_enc,
      multa_pct=excluded.multa_pct, juros_pct_mes=excluded.juros_pct_mes, atualizado_em=datetime('now')`)
    .run(empresaId, d.ativa ? 1 : 0, d.ambiente, d.client_id, cifrarTexto(cert), cifrarTexto(chave), d.multa_pct, d.juros_pct_mes);
  if (atual && atual.ambiente !== d.ambiente) db.prepare('UPDATE contas_cora SET ultima_sync_pagos = NULL, ultima_sync_extrato = NULL WHERE empresa_id = ?').run(empresaId);
  return obterContaCora(empresaId);
}

export function removerContaCora(empresaId: number) {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM cobrancas WHERE empresa_id = ? AND cora_id IS NOT NULL AND status IN ('REGISTRADO','REMETIDO')").get(empresaId) as any).n;
  if (n) throw new ErroNegocio(`Existem ${n} cobrança(s) em aberto na Cora. Quite ou cancele antes de remover a conta (ou apenas desative).`);
  db.prepare('DELETE FROM contas_cora WHERE empresa_id = ?').run(empresaId);
}

function api(empresaId: number): CoraApi {
  const c = db.prepare('SELECT ambiente, client_id, cert_enc, chave_enc FROM contas_cora WHERE empresa_id = ?').get(empresaId) as any;
  if (!c) throw new ErroNegocio('Esta empresa não tem conta Cora configurada.');
  const cred: CoraCredenciais = { clientId: c.client_id, ambiente: c.ambiente, certPem: decifrarTexto(c.cert_enc), chavePem: decifrarTexto(c.chave_enc) };
  return new CoraApi(cred);
}

/** Pega o token e lê o saldo: confirma que as credenciais funcionam. */
export async function testarCora(empresaId: number) {
  const a = api(empresaId);
  try {
    await a.token(true);
    const hoje = hojeBr();
    const e = await a.extrato(somaDias(hoje, -1), hoje);
    if (e.saldoFinal != null) db.prepare("UPDATE contas_cora SET saldo = ?, saldo_em = datetime('now') WHERE empresa_id = ?").run(e.saldoFinal, empresaId);
    return { ok: true, saldo: e.saldoFinal };
  } finally { a.fechar(); }
}

// ---------------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------------
const UF_IBGE: Record<string, string> = { '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF' };

/** Corpo do POST /v2/invoices. Lança ErroNegocio quando falta algo que a Cora exige. */
export function montarFatura(c: any, t: any, conta: any) {
  const falta = pendenciasPagador(t);
  if (falta.length) throw new ErroNegocio(`Complete o cadastro de ${t.nome}: ${falta.join(', ')}.`);
  if (c.valor < VALOR_MINIMO) throw new ErroNegocio(`A Cora não emite boleto abaixo de R$ 5,00 (esta cobrança é de R$ ${c.valor.toFixed(2).replace('.', ',')}).`);
  if (c.vencimento < hojeBr()) throw new ErroNegocio('O vencimento do boleto não pode estar no passado.');
  const doc = soDig(t.documento);
  const uf = t.uf || UF_IBGE[String(t.cod_municipio ?? '').slice(0, 2)] || '';
  const cond = condicoesDoBoleto(conta, c);
  const termos: any = { due_date: c.vencimento };
  if (cond.multa > 0) termos.fine = { rate: cond.multa };
  if (cond.juros > 0) termos.interest = { rate: cond.juros };
  let aviso: string | null = null;
  if (cond.pontual) {
    if (cond.pontual.ate === c.vencimento) termos.discount = { type: 'FIXED', value: centavos(c.valor - cond.pontual.valor) };
    else aviso = 'O desconto por pagamento antecipado (antes do vencimento) não é enviado à Cora, que só aceita desconto até o vencimento.';
  }
  const corpo: any = {
    code: `K${c.id}`,
    customer: {
      name: String(t.nome).slice(0, 60),
      ...(t.email ? { email: String(t.email).split(/[;,\s]/)[0].slice(0, 60) } : {}),
      document: { identity: doc, type: doc.length === 14 ? 'CNPJ' : 'CPF' },
      address: { street: t.logradouro, number: String(t.numero || 'S/N'), district: t.bairro, city: t.cidade, state: uf, complement: t.complemento || '-', zip_code: soDig(t.cep) },
    },
    services: [{ name: String(c.descricao).slice(0, 60), description: String(c.descricao).slice(0, 100), amount: centavos(c.valor) }],
    payment_terms: termos,
    payment_forms: c.forma === 'PIX' ? ['PIX'] : ['BANK_SLIP', 'PIX'],
  };
  return { corpo, aviso };
}

/** Registra a cobrança na Cora. Erro de dados fica na cobrança (sem repetir sozinho); erro de rede mantém a chave para repetir sem duplicar. */
export async function emitirNaCora(cobrancaId: number): Promise<void> {
  const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(cobrancaId) as any;
  if (!c || c.status !== 'AGUARDANDO_BANCO' || c.cora_id || !contaCoraAtiva(c.empresa_id)) return;
  const conta = db.prepare('SELECT * FROM contas_cora WHERE empresa_id = ?').get(c.empresa_id) as any;
  const t = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(c.tomador_id) as any;
  let pedido;
  try { pedido = montarFatura(c, t, conta); }
  catch (e: any) { db.prepare('UPDATE cobrancas SET observacao_banco = ? WHERE id = ?').run(e.message, cobrancaId); throw e; }
  const idem = c.cora_idem ?? crypto.randomUUID();
  db.prepare('UPDATE cobrancas SET cora_idem = ? WHERE id = ?').run(idem, cobrancaId);
  const a = api(c.empresa_id);
  try {
    const f = await a.emitir(pedido.corpo, idem);
    const bs = f.payment_options?.bank_slip;
    db.prepare(`UPDATE cobrancas SET status = 'REGISTRADO', cora_id = ?, cora_pdf_url = ?, nosso_numero = ?, linha_digitavel = ?, codigo_barras = ?, pix_copia_cola = COALESCE(?, pix_copia_cola),
        emissao = COALESCE(emissao, ?), observacao_banco = ? WHERE id = ?`)
      .run(f.id, bs?.url ?? null, bs?.our_number ?? null, bs?.digitable ?? null, bs?.barcode ?? null, f.pix?.emv ?? null, hojeBr(), pedido.aviso, cobrancaId);
  } catch (e: any) {
    if (e instanceof ErroRedeCora) {
      db.prepare('UPDATE cobrancas SET observacao_banco = ? WHERE id = ?').run(`Cora (tentará de novo): ${e.message}`, cobrancaId);
    } else {
      db.prepare('UPDATE cobrancas SET observacao_banco = ?, cora_idem = NULL WHERE id = ?').run(e.message, cobrancaId);
    }
    throw e;
  } finally { a.fechar(); }
}

/** Dispara a emissão em segundo plano logo depois de criar a cobrança. */
export function emitirEmSegundoPlano(cobrancaId: number) {
  setImmediate(() => { emitirNaCora(cobrancaId).catch(() => { /* o motivo já ficou na cobrança */ }); });
}

/** Emite o que ficou pendente. `todas` inclui as que falharam por dados (depois que o usuário corrigiu o cadastro). */
export async function emitirPendentes(empresaId: number, todas = false) {
  const q = db.prepare(`SELECT id, observacao_banco FROM cobrancas WHERE empresa_id = ? AND status = 'AGUARDANDO_BANCO' AND cora_id IS NULL AND vencimento >= ? LIMIT 100`).all(empresaId, hojeBr()) as any[];
  let ok = 0, falhas = 0;
  for (const c of q) {
    if (!todas && c.observacao_banco && !String(c.observacao_banco).startsWith('Cora (tentará de novo)')) continue;
    try { await emitirNaCora(c.id); ok++; } catch { falhas++; }
  }
  return { emitidas: ok, falhas };
}

// ---------------------------------------------------------------------------
// PDF do boleto (gerado pela Cora)
// ---------------------------------------------------------------------------
export async function pdfDaCora(cobrancaId: number): Promise<{ pdf: Buffer; nome: string }> {
  const c = db.prepare('SELECT id, cora_id, cora_pdf_url, cora_pdf, nosso_numero FROM cobrancas WHERE id = ?').get(cobrancaId) as any;
  if (!c?.cora_pdf_url) throw new ErroNegocio('A Cora ainda não devolveu o PDF deste boleto.');
  let pdf: Buffer | null = c.cora_pdf ? Buffer.from(c.cora_pdf) : null;
  if (!pdf) {
    const r = await fetch(c.cora_pdf_url);
    if (!r.ok) throw new ErroNegocio(`Não foi possível baixar o PDF do boleto na Cora (${r.status}).`);
    pdf = Buffer.from(await r.arrayBuffer());
    db.prepare('UPDATE cobrancas SET cora_pdf = ? WHERE id = ?').run(pdf, cobrancaId);
  }
  return { pdf, nome: `Boleto_${c.nosso_numero ?? c.id}.pdf` };
}

// ---------------------------------------------------------------------------
// Baixa automática
// ---------------------------------------------------------------------------
const emAndamento = new Set<string>();
async function exclusivo<T>(chave: string, fn: () => Promise<T>): Promise<T | null> {
  if (emAndamento.has(chave)) return null;
  emAndamento.add(chave);
  try { return await fn(); } finally { emAndamento.delete(chave); }
}

export async function sincronizarPagos(empresaId: number): Promise<{ baixadas: number }> {
  const r = await exclusivo(`pagos${empresaId}`, async () => {
    const conta = db.prepare('SELECT ultima_sync_pagos FROM contas_cora WHERE empresa_id = ?').get(empresaId) as any;
    if (!conta) return { baixadas: 0 };
    const abertas = db.prepare("SELECT id, cora_id FROM cobrancas WHERE empresa_id = ? AND cora_id IS NOT NULL AND status IN ('REGISTRADO','REMETIDO')").all(empresaId) as { id: number; cora_id: string }[];
    if (!abertas.length) { db.prepare("UPDATE contas_cora SET ultima_sync_pagos = ? WHERE empresa_id = ?").run(hojeBr(), empresaId); return { baixadas: 0 }; }
    const hoje = hojeBr();
    const inicio = conta.ultima_sync_pagos ? somaDias(conta.ultima_sync_pagos, -2) : somaDias(hoje, -45);
    const a = api(empresaId);
    try {
      const pagos = new Set(await a.listarPagos(inicio, hoje));
      let baixadas = 0;
      for (const c of abertas) {
        if (!pagos.has(c.cora_id)) continue;
        const f = await a.consultar(c.cora_id);
        if (f.status !== 'PAID') continue;
        const valor = f.total_paid ? reais(f.total_paid) : undefined;
        try { marcarPago(c.id, f.occurrence_date?.slice(0, 10) ?? hoje, valor); baixadas++; } catch { /* já encerrada */ }
      }
      db.prepare('UPDATE contas_cora SET ultima_sync_pagos = ? WHERE empresa_id = ?').run(hoje, empresaId);
      return { baixadas };
    } finally { a.fechar(); }
  });
  return r ?? { baixadas: 0 };
}

// ---------------------------------------------------------------------------
// Cancelamento (a Cora não altera boleto: mudar vencimento ou valor é cancelar e emitir outro)
// ---------------------------------------------------------------------------
export async function cancelarNaCora(cobrancaId: number): Promise<{ baixaNoBanco: boolean }> {
  const c = obterCobranca(cobrancaId);
  if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
  if (c.status === 'PAGO' || c.status === 'CANCELADO') throw new ErroNegocio('Esta cobrança já está encerrada.');
  if (c.cora_id) {
    const a = api(c.empresa_id);
    try {
      const r = await a.cancelar(c.cora_id);
      if (r === 'pago') {
        await sincronizarPagos(c.empresa_id);
        throw new ErroNegocio('Este boleto já foi pago na Cora, então não pode ser cancelado. A cobrança foi atualizada.');
      }
    } finally { a.fechar(); }
  }
  db.prepare("UPDATE cobrancas SET status = 'CANCELADO', baixa_pendente = 0 WHERE id = ?").run(cobrancaId);
  return { baixaNoBanco: false };
}

// ---------------------------------------------------------------------------
// Extrato e saldo
// ---------------------------------------------------------------------------
export async function sincronizarExtrato(empresaId: number): Promise<{ novos: number; saldo: number | null }> {
  const r = await exclusivo(`extrato${empresaId}`, async () => {
    const conta = db.prepare('SELECT ultima_sync_extrato FROM contas_cora WHERE empresa_id = ?').get(empresaId) as any;
    if (!conta) return { novos: 0, saldo: null };
    const hoje = hojeBr();
    const inicio = conta.ultima_sync_extrato ? somaDias(conta.ultima_sync_extrato, -3) : somaDias(hoje, -60);
    const a = api(empresaId);
    try {
      const e = await a.extrato(inicio, hoje);
      const lancs = e.lancamentos.filter((l) => l.type === 'CREDIT' || l.type === 'DEBIT').map((l) => {
        const t = l.transaction ?? {};
        const quando = new Date(new Date(l.createdAt).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
        const contra = t.counterParty?.name ? ` - ${t.counterParty.name}` : '';
        return { data: quando, descricao: `${t.description ?? t.type ?? 'Lançamento Cora'}${contra}`.slice(0, 200), documento: String(l.id), valor: (l.type === 'CREDIT' ? 1 : -1) * reais(l.amount), saldo: null as number | null, chave: crypto.createHash('sha1').update(`cora|${l.id}`).digest('hex') };
      });
      const hash = crypto.createHash('sha256').update(`${empresaId}|${lancs.map((l) => l.chave).join(',')}`).digest('hex');
      const novos = lancs.length ? importarLancamentosExternos(empresaId, { arquivo: `Cora (API) ${hoje}`, hash, periodoIni: inicio, periodoFim: hoje, saldoAnterior: e.saldoInicial, saldoFinal: e.saldoFinal, conta: 'Cora', lancamentos: lancs }).novos : 0;
      db.prepare("UPDATE contas_cora SET ultima_sync_extrato = ?, saldo = COALESCE(?, saldo), saldo_em = CASE WHEN ? IS NULL THEN saldo_em ELSE datetime('now') END WHERE empresa_id = ?").run(hoje, e.saldoFinal, e.saldoFinal, empresaId);
      return { novos, saldo: e.saldoFinal };
    } finally { a.fechar(); }
  });
  return r ?? { novos: 0, saldo: null };
}

// ---------------------------------------------------------------------------
// Rotina completa (botão "Atualizar" e temporizador)
// ---------------------------------------------------------------------------
export async function sincronizarTudo(empresaId: number, manual = false) {
  const emissao = await emitirPendentes(empresaId, manual);
  const pagos = await sincronizarPagos(empresaId);
  const extrato = await sincronizarExtrato(empresaId);
  return { ...emissao, baixadas: pagos.baixadas, extrato };
}

/** Chamado a cada 10 min pelo servidor: percorre as empresas com Cora ativa. */
export async function sincronizarAutomatico() {
  for (const e of db.prepare('SELECT empresa_id FROM contas_cora WHERE ativa = 1').all() as { empresa_id: number }[]) {
    try { await sincronizarTudo(e.empresa_id); } catch { /* tenta de novo no próximo ciclo */ }
  }
}
