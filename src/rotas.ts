import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cartaCobrancaPdf } from './servicos/carta-cobranca.js';
import { emitenteDaEmpresa } from './pdf/timbrado.js';
import { z } from 'zod';
import { db } from './db.js';
import { cifrar, cifrarTexto } from './cofre.js';
import { lembretesDoUsuario } from './servicos/lembretes.js';
import { MODULOS, conferirSenha, configurarPrimeiroAcesso, empresaPermitida, exigirLogin, exigirPapel, gerarToken, modulosDoUsuario, modulosPermitidos, restritoAEmpresas, sistemaConfigurado, type Usuario } from './auth.js';
import { EdicaoUsuario, NovoUsuario, confirmarRecuperacao, criarUsuario, editarUsuario, limparFalhas, listarUsuarios, loginBloqueado, redefinirSenha, registrarFalha, solicitarRecuperacao, trocarMinhaSenha } from './servicos/usuarios.js';
import { config } from './config.js';
import { ConfigSmtp, ListaEmails, assinaturaDoEscritorio, configPublica, enviarModeloTeste, enviarNotaPorEmail, enviarOrcamentoPorEmail, historicoEmails, previaModelo, salvarAssinatura, salvarConfig, testarConfig } from './servicos/email.js';
import { ModeloEditado, listarModelos, restaurarModelo, salvarModelo } from './servicos/modelos-email.js';
import { MODULOS_PAGOS, modulosLiberados, ativarLicenca, exigirLicenca, exigirLimite, PLANOS, SUPORTE_WHATSAPP, statusLicenca, usoAtual, acessoDeSuporte } from './licenca.js';
import { BoletoAvulso, EntradaFaturamento, enviarCobrancaPorEmail, faturar, gerarBoletoAvulso, listarCobrancas } from './servicos/faturamento.js';
import { ContaCoraEntrada, obterContaCora, salvarContaCora, removerContaCora, testarCora, sincronizarTudo, cancelarNaCora } from './servicos/cora.js';
import { ContaBancaria, obterModelosWhatsapp, reemitirCobranca, salvarModelosWhatsapp, boletoPdf, demonstrativoPdf, informarPix, ConfigPix, configPixPublica, gerarPixCobranca, gerarPixPendentes, salvarConfigPix, cancelarCobranca, gerarRemessaEmpresa, listarRemessas, marcarPago, obterCobranca, obterConta, obterRemessa, processarRetorno, salvarConta } from './servicos/cobranca.js';
import { Despesa, criarDespesa, editarDespesa, excluirDespesa, listarCategorias, listarDespesas, painelFinanceiro, salvarCategorias } from './servicos/financeiro.js';
import { ClassificacaoCartao, classificarCartao, excluirFatura, faturasDoMes, importarFatura } from './servicos/cartao.js';
import { Classificacao, balancoExtrato, candidatosBoleto, candidatosDespesa, classificar, conciliar, excluirImportacao, extratoDoMes, importarExtrato, ligarDespesa } from './servicos/extrato.js';
import { catalogo, gerarRelatorio, relatorioCsv, relatorioPdf } from './servicos/relatorios.js';
import { configurarAgenda, executarItem, executarProntas, listarAgenda, pularItem, resumoAgenda } from './servicos/agenda.js';
import { EdicaoImposto, Tributacao, criarTributacao, editarTributacao, excluirTributacao, listarTributacoes, Perfil, TipoDocumento, conferirTipoDoVinculo, criarPerfil, criarTipo, editarImposto, editarPerfil, editarTipo, excluirPerfil, excluirTipo, gerarPerfisDosServicos, listarImpostos, listarPerfis, listarTipos, tributacaoCompletaDoServico, tributacaoEfetiva, NATUREZAS } from './servicos/tributacao.js';
import { DescricaoModelo, EntradaDescricao, lerModelo, montarDescricao } from './servicos/descricao.js';
import { CompraManual, OpcoesImportacao, fornecedoresDaEmpresa, ParcelaEditada, alterarParcelas, previaCompraXml, criarCompraManual, excluirCompra, importarCompraXml, listarCompras, obterCompra, xmlDaCompra } from './servicos/compras.js';
import { ConfigFechamento, configFechamento, enviarFechamento, mesAnterior, pacoteContabilidade, salvarFechamento } from './servicos/contabilidade.js';
import { ImportacaoRecebidas, buscarNaSefaz, buscarPorChave, configurarBusca, importarRecebidas, liberarCiencias, listarRecebidas, ocultarRecebida, xmlRecebida } from './servicos/nfe-recebidas.js';
import { apagarCadeiaIcp, baixarCadeiaIcp, definirVerificacaoServidor, extrairCertificadosAc, guardarCadeiaIcp, statusConfianca } from './nfe/confianca.js';
import { criarBackup, listarBackups } from './servicos/backup.js';
import { analisarPlanilha, importarLote } from './servicos/importar-clientes.js';
import { consultarCnpj } from './servicos/consulta-cnpj.js';
import { strToU8, zipSync } from 'fflate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerPfx } from './nfse/certificado.js';
import { codMunicipioValido, cTribNacValido, documentoValido, limparDoc, soDigitos } from './nfse/validacao.js';
import { EntradaEmissao, ErroNegocio, cancelar, danfse, emitir, enviar, excluirNota, importarNotaXml, obterNota, reconciliar } from './servicos/emissao.js';
import { MOTIVOS_CANCELAMENTO } from './nfse/evento.js';

import { EntradaOrcamento, atualizarOrcamento, conferirAntesDeEmitir, conversao, criarOrcamento, duplicarOrcamento, excluirOrcamento, listarOrcamentos, mudarSituacao, obterOrcamento, orcamentoPdf, vincularNota } from './servicos/orcamentos.js';
const u = (req: FastifyRequest) => req.usuario as Usuario;

function checarEmpresa(req: FastifyRequest, empresaId: number) {
  if (!empresaPermitida(u(req), empresaId)) throw new ErroNegocio('Empresa não encontrada.', 404);
}

function notaDoUsuario(req: FastifyRequest, id: number) {
  const n = db.prepare('SELECT empresa_id FROM notas WHERE id = ?').get(id) as { empresa_id: number } | undefined;
  if (!n) throw new ErroNegocio('Nota não encontrada.', 404);
  checarEmpresa(req, n.empresa_id);
}

const Empresa = z.object({
  documento: z.string().transform(limparDoc).refine(documentoValido, 'CNPJ/CPF inválido'),
  razao_social: z.string().min(2),
  nome_fantasia: z.string().nullish(),
  inscricao_municipal: z.string().nullish(),
  cod_municipio: z.string().refine(codMunicipioValido, 'Código IBGE do município deve ter 7 dígitos'),
  uf: z.string().length(2).nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  op_simp_nac: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reg_ap_trib_sn: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullish(),
  reg_esp_trib: z.number().int().min(0).max(9).default(0),
  p_tot_trib_sn: z.number().min(0).max(100).nullish(),
  ambiente: z.union([z.literal(1), z.literal(2)]).default(2),
  serie: z.string().regex(/^\d{1,5}$/, 'Série deve ser numérica, até 5 dígitos').default('1'),
  /** CERTIFICADO = emite pelo sistema com A1; PORTAL = a nota é emitida no Emissor Nacional (CNPJ e senha) e importada aqui. */
  modo_emissao: z.enum(['CERTIFICADO', 'PORTAL']).default('CERTIFICADO'),
  portal_login: z.string().trim().max(60).nullish(),
  portal_senha: z.string().max(200).nullish(),
}).refine((e) => e.modo_emissao !== 'PORTAL' || !!e.portal_login, { path: ['portal_login'], message: 'Informe o usuário (CNPJ) de acesso ao portal' });

const Tomador = z.object({
  tipo_doc: z.enum(['CPF', 'CNPJ', 'SEM']),
  documento: z.string().nullish().transform((d) => (d ? limparDoc(d) : null)),
  nome: z.string().min(2).max(300),
  inscricao_municipal: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  fone: z.string().nullish().transform((f) => (f ? soDigitos(f) : null)),
  cep: z.string().nullish().transform((c) => (c ? soDigitos(c) : null)),
  cod_municipio: z.string().nullish(),
  logradouro: z.string().nullish(),
  numero: z.string().nullish(),
  complemento: z.string().nullish(),
  bairro: z.string().nullish(),
  cidade: z.string().max(60).nullish(),
  uf: z.string().length(2).nullish().or(z.literal('')),
  // faturamento do cliente
  modo_faturamento: z.enum(['NOTA', 'NOTA_BOLETO', 'BOLETO']).default('NOTA'),
  vencimento_tipo: z.enum(['PRAZO', 'DIA_FIXO']).default('PRAZO'),
  vencimento_valor: z.number().int().min(0).max(60).default(10),
  email_cobranca: z.string().nullish().refine((v) => !v || v.split(/[,;\s]+/).filter(Boolean).every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)), 'E-mail de cobrança inválido'),
  enviar_email_auto: z.union([z.boolean(), z.literal(0), z.literal(1)]).default(false).transform((v) => (v ? 1 : 0)),
  desconto_valor: z.number().min(0).max(99999999).nullish().transform((v) => (v && v > 0 ? Math.round(v * 100) / 100 : null)),
  desconto_motivo: z.string().trim().max(80).nullish().transform((v) => v || null),
  /** Em branco = usa a multa/juros da conta bancária da empresa. */
  multa_pct: z.number().min(0).max(20).nullish().transform((v) => v ?? null),
  juros_pct_mes: z.number().min(0).max(20).nullish().transform((v) => v ?? null),
  /** Desconto para pagamento antecipado: % do boleto, até N dias antes do vencimento (0 = até o vencimento). */
  desc_pontual_pct: z.number().min(0).max(100).nullish().transform((v) => (v && v > 0 ? v : null)),
  desc_pontual_dias: z.number().int().min(0).max(60).nullish().transform((v) => v ?? null),
  /** true = o cadastro foi conferido (tira a marca "falta conferir"). */
  conferido: z.boolean().nullish(),
  /** Carteira de cobrança: boleto ou Pix copia e cola. */
  forma_cobranca: z.enum(['BOLETO', 'PIX']).nullish(),
  descricao_modelo: DescricaoModelo.nullish().transform((m) => (m ? JSON.stringify(m) : null)),
  /** Serviços que o sistema sempre usa com este cliente, com o valor de cada um. */
  servicos_padrao: z.array(z.object({
    servico_id: z.number().int(), valor: z.number().positive('Informe o valor do serviço'),
    descricao: z.string().trim().max(2000).nullish().transform((v) => v || null), padrao: z.boolean().nullish(),
  })).max(20).default([]).refine((l) => new Set(l.map((x) => x.servico_id)).size === l.length, 'O mesmo serviço foi escolhido duas vezes'),
}).refine((t) => t.modo_faturamento === 'NOTA' || t.vencimento_tipo === 'PRAZO' || (t.vencimento_valor >= 1 && t.vencimento_valor <= 31), { message: 'Dia do vencimento deve ser de 1 a 31', path: ['vencimento_valor'] })

.refine((t) => !t.desconto_valor || !!t.desconto_motivo, { message: 'Informe o motivo do desconto', path: ['desconto_motivo'] })
.refine((t) => t.tipo_doc === 'SEM' || (t.documento && documentoValido(t.documento)), { message: 'CPF/CNPJ do tomador inválido', path: ['documento'] });

const Servico = z.object({
  nome: z.string().min(1),
  descricao: z.string().min(1).max(2000),
  c_trib_nac: z.string().transform(soDigitos).refine(cTribNacValido, 'Código de tributação nacional tem 6 dígitos (ex.: 171901)'),
  c_trib_mun: z.string().nullish(),
  c_nbs: z.string().nullish().transform((c) => (c ? soDigitos(c) : null)),
  aliquota: z.number().min(0).max(100).nullish(),
  valor_padrao: z.number().min(0).nullish(),
  tributacao: z.object({
    tribISSQN: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
    tpImunidade: z.number().int().min(0).max(9).nullish(),
    issRetido: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    pPis: z.number().min(0).max(100).nullish(), pCofins: z.number().min(0).max(100).nullish(),
    pCsll: z.number().min(0).max(100).nullish(), pIrrf: z.number().min(0).max(100).nullish(), pCp: z.number().min(0).max(100).nullish(),
    pTotTrib: z.object({ fed: z.number().min(0).max(100).nullish(), est: z.number().min(0).max(100).nullish(), mun: z.number().min(0).max(100).nullish() }).nullish(),
    municipioPrestacao: z.string().regex(/^\d{7}$/, 'Município da prestação: código IBGE de 7 dígitos').nullish().or(z.literal('').transform(() => null)),
    infoComplementar: z.string().max(2000).nullish(),
  }).nullish(),
  tipo_documento_id: z.number().int().nullish(),
  ibscbs: z.object({
    indFinal: z.union([z.literal(0), z.literal(1)]),
    cIndOp: z.string().regex(/^\d{6}$/, 'Indicador da operação (cIndOp) precisa ter 6 dígitos'),
    indDest: z.union([z.literal(0), z.literal(1)]),
    cst: z.string().regex(/^\d{3}$/, 'CST do IBS/CBS precisa ter 3 dígitos (ex.: 000 = tributação integral)'),
    cClassTrib: z.string().regex(/^\d{6}$/, 'Classificação tributária (cClassTrib) precisa ter 6 dígitos (ex.: 000001)'),
  }).nullish(),
}).refine((s) => !s.ibscbs || !!s.c_nbs, { path: ['c_nbs'], message: 'Com IBS/CBS o código NBS é obrigatório' });

const semCert = (e: any) => {
  const { cert_pfx_enc, cert_senha_enc, logo, portal_senha_enc, ...resto } = e;
  return { ...resto, tem_certificado: !!cert_pfx_enc, tem_logo: !!logo, tem_senha_portal: !!portal_senha_enc };
};

const VERSAO: string = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version; } catch { return ''; }
})();

export async function rotas(app: FastifyInstance) {
  // ---------- Primeiro acesso ----------
  app.get('/api/setup/status', async () => ({ configurado: sistemaConfigurado(), desktop: config.desktop, versao: VERSAO }));

  app.post('/api/setup', async (req, reply) => {
    const d = z.object({
      escritorio: z.string().min(2, 'Informe o nome do escritório'),
      nome: z.string().min(2, 'Informe seu nome'),
      usuario: z.string().trim().regex(/^[A-Za-z0-9._-]{3,30}$/, 'Usuário: 3 a 30 letras ou números, sem espaços nem acentos').optional(),
      email: z.string().email('E-mail inválido'),
      senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
    }).parse(req.body);
    if (sistemaConfigurado()) return reply.code(409).send({ erro: 'O sistema já foi configurado.' });
    const id = configurarPrimeiroAcesso(d);
    return { token: gerarToken(id) };
  });

  // ---------- Autenticação ----------
  app.post('/api/login', async (req, reply) => {
    // "usuario" é o campo atual; "email" continua aceito (instalações e integrações antigas)
    const c = z.object({ usuario: z.string().optional(), email: z.string().optional(), senha: z.string() }).parse(req.body);
    const nome = (c.usuario ?? c.email ?? '').trim();
    const chave = nome.toUpperCase();
    if (loginBloqueado(chave)) return reply.code(429).send({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    const usr = db.prepare('SELECT * FROM usuarios WHERE (login = ? OR email = ?) AND ativo = 1').get(chave, nome.toLowerCase()) as any;
    // master (suporte Kontor): sem senha; entra só com código de suporte assinado, deste computador e ainda válido
    let expiraSuporte: string | undefined;
    if (usr?.mestre) {
      try { expiraSuporte = acessoDeSuporte(c.senha); } catch { registrarFalha(chave); return reply.code(401).send({ erro: 'Usuário ou senha incorretos.' }); }
      req.log.warn({ usuario: usr.login, expira: expiraSuporte }, 'Acesso de suporte (master) com código assinado');
    } else if (!usr || !conferirSenha(c.senha, usr.senha_hash)) { registrarFalha(chave); return reply.code(401).send({ erro: 'Usuário ou senha incorretos.' }); }
    limparFalhas(chave);
    return { token: gerarToken(usr.id, expiraSuporte ? Date.parse(expiraSuporte) : undefined), usuario: { id: usr.id, nome: usr.nome, login: usr.login, papel: usr.papel, tipo: usr.tipo }, trocar_senha: !!usr.trocar_senha };
  });

  // Esqueci minha senha: manda um código ao e-mail cadastrado; ao confirmá-lo a senha volta para a padrão.
  const respostaRecuperacao = { ok: true, mensagem: 'Se este usuário tiver um e-mail cadastrado, enviamos um código de 6 dígitos (vale 15 minutos). Se não chegar, peça a um administrador para redefinir sua senha.' };
  app.post('/api/esqueci-senha', async (req) => {
    const { usuario } = z.object({ usuario: z.string().min(1, 'Informe o usuário') }).parse(req.body);
    await solicitarRecuperacao(usuario);
    return respostaRecuperacao;
  });
  app.post('/api/esqueci-senha/confirmar', async (req) => {
    const d = z.object({ usuario: z.string().min(1), codigo: z.string().regex(/^\d{6}$/, 'O código tem 6 dígitos'), nova: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres') }).parse(req.body);
    confirmarRecuperacao(d.usuario, d.codigo, d.nova);
    return { ok: true, mensagem: 'Pronto! Sua nova senha já vale. Entre com ela.' };
  });

  app.register(async (api) => {
    api.addHook('preHandler', exigirLogin);

    api.get('/api/me', async (req) => {
      const { senha_hash, permissoes, sessao_v, ...resto } = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u(req).id) as any;
      const email = /@(sem-email|kontor)\.local$/.test(resto.email) ? '' : resto.email;
      // módulos vendidos à parte que o usuário teria, mas a licença não traz: o menu mostra "contratar"
      const lib = modulosLiberados();
      const naoContratados = modulosPermitidos(u(req)).filter((m) => MODULOS_PAGOS[m] && !lib.includes(m)).map((m) => ({ id: m, nome: MODULOS_PAGOS[m].nome, resumo: MODULOS_PAGOS[m].resumo }));
      return { ...resto, email, modulos: modulosDoUsuario(u(req)), todosModulos: MODULOS, naoContratados };
    });
    api.put('/api/me/senha', async (req) => {
      const d = z.object({ atual: z.string(), nova: z.string() }).parse(req.body);
      trocarMinhaSenha(u(req), d.atual, d.nova);
      return { ok: true, token: gerarToken(u(req).id) };
    });
    api.put('/api/me/avatar', async (req) => {
      const { avatar } = z.object({ avatar: z.string().regex(/^[a-z0-9-]{1,24}$/, 'Avatar inválido.').nullable() }).parse(req.body);
      db.prepare('UPDATE usuarios SET avatar = ? WHERE id = ?').run(avatar, u(req).id);
      return { ok: true, avatar };
    });
    api.put('/api/me/empresa', async (req) => {
      const { id } = z.object({ id: z.number().int() }).parse(req.body);
      if (!empresaPermitida(u(req), id)) throw new ErroNegocio('Empresa não permitida.', 403);
      db.prepare('UPDATE usuarios SET ultima_empresa_id = ? WHERE id = ?').run(id, u(req).id);
      return { ok: true };
    });

    // ---------- Usuários e acessos (somente adm) ----------
    api.get('/api/usuarios', async (req) => listarUsuarios(u(req).escritorio_id));
    api.post('/api/usuarios', async (req) => criarUsuario(u(req), NovoUsuario.parse(req.body)));
    api.put('/api/usuarios/:id', async (req) => {
      editarUsuario(u(req), Number((req.params as any).id), EdicaoUsuario.parse(req.body));
      return { ok: true };
    });
    api.post('/api/usuarios/:id/redefinir-senha', async (req) => {
      return { ok: true, senhaProvisoria: redefinirSenha(u(req), Number((req.params as any).id)) };
    });

    // ---------- Lembretes do sininho do topo ----------
    api.get('/api/inicio', async (req) => {
      const usr = u(req);
      const ids = restritoAEmpresas(usr) ? (db.prepare('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?').all(usr.id) as { empresa_id: number }[]).map((x) => x.empresa_id) : null;
      return { lembretes: lembretesDoUsuario(usr.escritorio_id, modulosDoUsuario(usr), ids) };
    });

    // ---------- Empresas (prestadores) ----------
    api.get('/api/empresas', async (req) => {
      const usr = u(req);
      const linhas = restritoAEmpresas(usr)
        ? db.prepare('SELECT e.* FROM empresas e JOIN usuario_empresas ue ON ue.empresa_id = e.id WHERE ue.usuario_id = ? ORDER BY razao_social').all(usr.id)
        : db.prepare('SELECT * FROM empresas WHERE escritorio_id = ? ORDER BY razao_social').all(usr.escritorio_id);
      return linhas.map(semCert);
    });

    api.post('/api/empresas', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const d = Empresa.parse(req.body);
      exigirLimite('empresas');
      const r = db.prepare(`INSERT INTO empresas (escritorio_id, documento, razao_social, nome_fantasia, inscricao_municipal, cod_municipio, uf, email,
        op_simp_nac, reg_ap_trib_sn, reg_esp_trib, p_tot_trib_sn, ambiente, serie, modo_emissao, portal_login, portal_senha_enc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(u(req).escritorio_id, d.documento, d.razao_social, d.nome_fantasia ?? null, d.inscricao_municipal ?? null, d.cod_municipio,
          d.uf ?? null, d.email || null, d.op_simp_nac, d.op_simp_nac === 3 ? d.reg_ap_trib_sn ?? 1 : null, d.reg_esp_trib,
          d.p_tot_trib_sn ?? null, d.ambiente, d.serie, d.modo_emissao, d.modo_emissao === 'PORTAL' ? d.portal_login ?? null : null,
          d.modo_emissao === 'PORTAL' && d.portal_senha ? cifrarTexto(d.portal_senha) : null);
      return { id: Number(r.lastInsertRowid) };
    });

    api.put('/api/empresas/:id', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const d = Empresa.parse(req.body);
      db.prepare(`UPDATE empresas SET documento=?, razao_social=?, nome_fantasia=?, inscricao_municipal=?, cod_municipio=?, uf=?, email=?,
        op_simp_nac=?, reg_ap_trib_sn=?, reg_esp_trib=?, p_tot_trib_sn=?, ambiente=?, serie=?, modo_emissao=?, portal_login=? WHERE id=?`)
        .run(d.documento, d.razao_social, d.nome_fantasia ?? null, d.inscricao_municipal ?? null, d.cod_municipio, d.uf ?? null, d.email || null,
          d.op_simp_nac, d.op_simp_nac === 3 ? d.reg_ap_trib_sn ?? 1 : null, d.reg_esp_trib, d.p_tot_trib_sn ?? null, d.ambiente, d.serie,
          d.modo_emissao, d.modo_emissao === 'PORTAL' ? d.portal_login ?? null : null, id);
      // a senha só muda quando uma nova é digitada; ao voltar para certificado, ela é apagada
      if (d.modo_emissao !== 'PORTAL') db.prepare('UPDATE empresas SET portal_senha_enc = NULL WHERE id = ?').run(id);
      else if (d.portal_senha) db.prepare('UPDATE empresas SET portal_senha_enc = ? WHERE id = ?').run(cifrarTexto(d.portal_senha), id);
      return { ok: true };
    });

    /** Upload do certificado A1: multipart com campos "arquivo" (.pfx) e "senha". */
    api.post('/api/empresas/:id/certificado', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      let pfx: Buffer | null = null;
      let senha = '';
      for await (const parte of req.parts()) {
        if (parte.type === 'file') pfx = await parte.toBuffer();
        else if (parte.fieldname === 'senha') senha = String(parte.value);
      }
      if (!pfx) throw new ErroNegocio('Envie o arquivo .pfx do certificado.');
      const cert = lerPfx(pfx, senha);
      const empresa = db.prepare('SELECT documento FROM empresas WHERE id = ?').get(id) as { documento: string };
      if (cert.documento && cert.documento.slice(0, 8) !== empresa.documento.slice(0, 8)) {
        throw new ErroNegocio(`O certificado pertence ao documento ${cert.documento}, diferente do cadastro da empresa.`);
      }
      if (cert.validoAte < new Date()) throw new ErroNegocio('Certificado vencido.');
      db.prepare('UPDATE empresas SET cert_pfx_enc = ?, cert_senha_enc = ?, cert_titular = ?, cert_validade = ? WHERE id = ?')
        .run(cifrar(pfx), cifrarTexto(senha), cert.titular, cert.validoAte.toISOString(), id);
      return { titular: cert.titular, validade: cert.validoAte };
    });

    /** Logo da empresa (PNG ou JPG, até 1 MB) usada no cabeçalho do DANFSe. */
    api.post('/api/empresas/:id/logo', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      let img: Buffer | null = null;
      for await (const parte of req.parts()) if (parte.type === 'file') img = await parte.toBuffer();
      if (!img) throw new ErroNegocio('Envie a imagem da logo.');
      const png = img.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpg = img[0] === 0xff && img[1] === 0xd8;
      if (!png && !jpg) throw new ErroNegocio('A logo precisa ser um arquivo PNG ou JPG.');
      db.prepare('UPDATE empresas SET logo = ? WHERE id = ?').run(img, id);
      return { ok: true };
    });
    api.delete('/api/empresas/:id/logo', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      db.prepare('UPDATE empresas SET logo = NULL WHERE id = ?').run(id);
      return { ok: true };
    });

    // ---------- Tomadores ----------
    type ServicoPadrao = { servico_id: number; valor: number; descricao: string | null; padrao?: boolean | null };
    const conferirServicosPadrao = (empresaId: number, l: ServicoPadrao[]) => {
      for (const s of l) if (!db.prepare('SELECT 1 FROM servicos WHERE id = ? AND empresa_id = ? AND ativo = 1').get(s.servico_id, empresaId)) throw new ErroNegocio('Serviço padrão não encontrado nesta empresa.');
    };
    const salvarServicosPadrao = (empresaId: number, tomadorId: number, l: ServicoPadrao[]) => {
      db.prepare('DELETE FROM tomador_servicos WHERE tomador_id = ?').run(tomadorId);
      const principal = l.findIndex((s) => s.padrao);
      const ins = db.prepare('INSERT INTO tomador_servicos (tomador_id, servico_id, valor, descricao, padrao) VALUES (?,?,?,?,?)');
      l.forEach((s, i) => ins.run(tomadorId, s.servico_id, s.valor, s.descricao, i === (principal >= 0 ? principal : 0) ? 1 : 0));
    };
    api.get('/api/empresas/:id/tomadores', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const q = `%${((req.query as any).q ?? '').trim()}%`;
      const linhas = db.prepare('SELECT * FROM tomadores WHERE empresa_id = ? AND (nome LIKE ? OR documento LIKE ?) ORDER BY nome LIMIT 200').all(id, q, q) as any[];
      const sp = db.prepare('SELECT ts.servico_id, ts.valor, ts.descricao, ts.padrao, s.nome AS servico_nome FROM tomador_servicos ts LEFT JOIN servicos s ON s.id = ts.servico_id WHERE ts.tomador_id = ? ORDER BY ts.padrao DESC, ts.id');
      return linhas.map((t) => ({ ...t, servicos_padrao: (sp.all(t.id) as any[]).map((x) => ({ ...x, padrao: !!x.padrao })) }));
    });
    api.post('/api/empresas/:id/tomadores/planilha/analisar', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const b = z.object({ nome: z.string().max(200).default('planilha.xlsx'), base64: z.string().min(20) }).parse(req.body);
      return analisarPlanilha(id, b.nome, Buffer.from(b.base64, 'base64'));
    });
    api.post('/api/empresas/:id/tomadores/planilha/importar', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const b = z.object({ itens: z.array(z.object({ documento: z.string().max(20), nome: z.string().max(300).nullish() })).min(1).max(10) }).parse(req.body);
      return { resultados: await importarLote(id, b.itens) };
    });
    api.post('/api/empresas/:id/tomadores', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const d = Tomador.parse(req.body);
      exigirLimite('clientes', d.documento);
      conferirServicosPadrao(id, d.servicos_padrao);
      const r = db.prepare(`INSERT INTO tomadores (empresa_id, tipo_doc, documento, nome, inscricao_municipal, email, fone, cep, cod_municipio, logradouro, numero, complemento, bairro,
        modo_faturamento, vencimento_tipo, vencimento_valor, email_cobranca, enviar_email_auto, cidade, uf, desconto_valor, desconto_motivo, descricao_modelo, multa_pct, juros_pct_mes, desc_pontual_pct, desc_pontual_dias)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, d.tipo_doc, d.documento, d.nome, d.inscricao_municipal ?? null, d.email || null, d.fone, d.cep,
        d.cod_municipio ?? null, d.logradouro ?? null, d.numero ?? null, d.complemento ?? null, d.bairro ?? null,
        d.modo_faturamento, d.vencimento_tipo, d.vencimento_valor, d.email_cobranca || null, d.enviar_email_auto, d.cidade || null, d.uf || null, d.desconto_valor, d.desconto_motivo, d.descricao_modelo, d.multa_pct, d.juros_pct_mes, d.desc_pontual_pct, d.desc_pontual_dias);
      if (d.forma_cobranca) db.prepare('UPDATE tomadores SET forma_cobranca = ? WHERE id = ?').run(d.forma_cobranca, Number(r.lastInsertRowid));
      salvarServicosPadrao(id, Number(r.lastInsertRowid), d.servicos_padrao);
      return { id: Number(r.lastInsertRowid) };
    });
    api.put('/api/tomadores/:id', async (req) => {
      const id = Number((req.params as any).id);
      const t = db.prepare('SELECT empresa_id FROM tomadores WHERE id = ?').get(id) as any;
      if (!t) throw new ErroNegocio('Tomador não encontrado.', 404);
      checarEmpresa(req, t.empresa_id);
      const d = Tomador.parse(req.body);
      conferirServicosPadrao(t.empresa_id, d.servicos_padrao);
      db.prepare(`UPDATE tomadores SET tipo_doc=?, documento=?, nome=?, inscricao_municipal=?, email=?, fone=?, cep=?, cod_municipio=?, logradouro=?, numero=?, complemento=?, bairro=?,
        modo_faturamento=?, vencimento_tipo=?, vencimento_valor=?, email_cobranca=?, enviar_email_auto=?, cidade=?, uf=?, desconto_valor=?, desconto_motivo=?, descricao_modelo=?, multa_pct=?, juros_pct_mes=?, desc_pontual_pct=?, desc_pontual_dias=? WHERE id=?`)
        .run(d.tipo_doc, d.documento, d.nome, d.inscricao_municipal ?? null, d.email || null, d.fone, d.cep, d.cod_municipio ?? null,
          d.logradouro ?? null, d.numero ?? null, d.complemento ?? null, d.bairro ?? null,
          d.modo_faturamento, d.vencimento_tipo, d.vencimento_valor, d.email_cobranca || null, d.enviar_email_auto, d.cidade || null, d.uf || null, d.desconto_valor, d.desconto_motivo, d.descricao_modelo, d.multa_pct, d.juros_pct_mes, d.desc_pontual_pct, d.desc_pontual_dias, id);
      if (d.conferido) db.prepare('UPDATE tomadores SET conferir = 0, conferir_motivo = NULL WHERE id = ?').run(id);
      if (d.forma_cobranca) db.prepare('UPDATE tomadores SET forma_cobranca = ? WHERE id = ?').run(d.forma_cobranca, id);
      salvarServicosPadrao(t.empresa_id, id, d.servicos_padrao);
      return { ok: true };
    });

    api.post('/api/tomadores/:id/descricao', async (req) => {
      const id = Number((req.params as any).id);
      const t = db.prepare('SELECT empresa_id, descricao_modelo FROM tomadores WHERE id = ?').get(id) as any;
      if (!t) throw new ErroNegocio('Tomador não encontrado.', 404);
      checarEmpresa(req, t.empresa_id);
      const modelo = lerModelo(t.descricao_modelo);
      if (!modelo) throw new ErroNegocio('Este cliente não tem modelo de descrição ativo.');
      try { return montarDescricao(modelo, EntradaDescricao.parse(req.body)); } catch (e) { if (e instanceof ErroNegocio || (e as any)?.issues) throw e; throw new ErroNegocio((e as Error).message); }
    });

    // ---------- Serviços ----------
    api.get('/api/empresas/:id/servicos', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return db.prepare('SELECT * FROM servicos WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(id)
        .map((s: any) => { const c = tributacaoCompletaDoServico(s); return { ...s, aliquota: c.aliquota, ibscbs: c.ibscbs, tributacao: c.tributacao }; });
    });
    api.post('/api/empresas/:id/servicos', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const d = Servico.parse(req.body);
      const r = db.prepare(`INSERT INTO servicos (empresa_id, nome, descricao, c_trib_nac, c_trib_mun, c_nbs, aliquota, valor_padrao, ibscbs_json, tributacao_json, tipo_documento_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, d.nome, d.descricao, d.c_trib_nac, d.c_trib_mun || null, d.c_nbs, d.aliquota ?? null, d.valor_padrao ?? null, d.ibscbs ? JSON.stringify(d.ibscbs) : null, d.tributacao ? JSON.stringify(d.tributacao) : null, conferirTipoDoVinculo(id, d.tipo_documento_id, 'SAIDA'));
      return { id: Number(r.lastInsertRowid) };
    });
    api.put('/api/servicos/:id', async (req) => {
      const id = Number((req.params as any).id);
      const s = db.prepare('SELECT * FROM servicos WHERE id = ?').get(id) as any;
      if (!s) throw new ErroNegocio('Serviço não encontrado.', 404);
      checarEmpresa(req, s.empresa_id);
      const d = Servico.parse(req.body);
      // a tributação agora vem do tipo de documento; o que está gravado no serviço só é trocado se a chamada trouxer
      const json = (novo: unknown, atual: string | null) => (novo === undefined ? atual : novo ? JSON.stringify(novo) : null);
      const tipo = d.tipo_documento_id === undefined ? s.tipo_documento_id : conferirTipoDoVinculo(s.empresa_id, d.tipo_documento_id, 'SAIDA');
      db.prepare(`UPDATE servicos SET nome=?, descricao=?, c_trib_nac=?, c_trib_mun=?, c_nbs=?, aliquota=?, valor_padrao=?, ibscbs_json=?, tributacao_json=?, tipo_documento_id=? WHERE id=?`)
        .run(d.nome, d.descricao, d.c_trib_nac, d.c_trib_mun || null, d.c_nbs, d.aliquota === undefined ? s.aliquota : d.aliquota ?? null, d.valor_padrao ?? null, json(d.ibscbs, s.ibscbs_json), json(d.tributacao, s.tributacao_json), tipo, id);
      return { ok: true };
    });
    api.delete('/api/servicos/:id', async (req) => {
      const id = Number((req.params as any).id);
      const s = db.prepare('SELECT empresa_id FROM servicos WHERE id = ?').get(id) as any;
      if (!s) throw new ErroNegocio('Serviço não encontrado.', 404);
      checarEmpresa(req, s.empresa_id);
      db.prepare('UPDATE servicos SET ativo = 0 WHERE id = ?').run(id);
      return { ok: true };
    });

    // ---------- Notas ----------
    api.get('/api/notas', async (req) => {
      const q = req.query as any;
      const usr = u(req);
      const filtros: string[] = ['e.escritorio_id = ?'];
      const params: unknown[] = [usr.escritorio_id];
      if (restritoAEmpresas(usr)) { filtros.push('e.id IN (SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?)'); params.push(usr.id); }
      if (q.empresaId) { filtros.push('n.empresa_id = ?'); params.push(Number(q.empresaId)); }
      if (q.status) { filtros.push('n.status = ?'); params.push(q.status); }
      if (q.mes) { filtros.push("substr(n.competencia, 1, 7) = ?"); params.push(q.mes); }
      if (q.q) { filtros.push('(n.tomador_nome LIKE ? OR n.n_nfse = ? OR n.descricao LIKE ?)'); params.push(`%${q.q}%`, q.q, `%${q.q}%`); }
      return db.prepare(`SELECT n.id, n.empresa_id, e.razao_social AS empresa, n.ambiente, n.serie, n.n_dps, n.n_nfse, n.status, n.competencia,
        n.valor_servico, n.tomador_nome, n.tomador_documento, n.descricao, n.chave_acesso, n.criado_em, n.erros_json
        FROM notas n JOIN empresas e ON e.id = n.empresa_id WHERE ${filtros.join(' AND ')} ORDER BY n.id DESC LIMIT 500`).all(...params);
    });

    // ---------- E-mail (SMTP do escritório) ----------
    api.get('/api/email/config', { preHandler: exigirPapel('admin') }, async (req) => configPublica(u(req).escritorio_id));
    api.put('/api/email/config', { preHandler: exigirPapel('admin') }, async (req) => {
      salvarConfig(u(req).escritorio_id, ConfigSmtp.parse(req.body));
      return { ok: true };
    });
    api.post('/api/email/testar', { preHandler: exigirPapel('admin') }, async (req) => {
      const { para } = z.object({ para: z.string().email('E-mail de destino inválido') }).parse(req.body);
      await testarConfig(u(req).escritorio_id, para);
      return { ok: true };
    });
    // modelos de e-mail e assinatura
    api.get('/api/email/modelos', { preHandler: exigirPapel('admin') }, async () => listarModelos());
    api.put('/api/email/modelos/:chave', { preHandler: exigirPapel('admin') }, async (req) => salvarModelo((req.params as any).chave, ModeloEditado.parse(req.body)));
    api.delete('/api/email/modelos/:chave', { preHandler: exigirPapel('admin') }, async (req) => restaurarModelo((req.params as any).chave));
    api.post('/api/email/modelos/:chave/previa', { preHandler: exigirPapel('admin') }, async (req) => previaModelo(u(req).escritorio_id, (req.params as any).chave, req.body ? ModeloEditado.parse(req.body) : undefined));
    api.post('/api/email/modelos/:chave/teste', { preHandler: exigirPapel('admin') }, async (req) => {
      const d = ModeloEditado.extend({ para: z.string().email('E-mail de destino inválido') }).parse(req.body);
      await enviarModeloTeste(u(req).escritorio_id, (req.params as any).chave, d.para, { assunto: d.assunto, corpo: d.corpo });
      return { ok: true };
    });
    api.get('/api/email/assinatura', { preHandler: exigirPapel('admin') }, async (req) => {
      const a = assinaturaDoEscritorio(u(req).escritorio_id);
      return { tem: !!a, imagem: a ? `data:${a.mime};base64,${a.img.toString('base64')}` : null };
    });
    api.put('/api/email/assinatura', { preHandler: exigirPapel('admin'), bodyLimit: 2 * 1024 * 1024 }, async (req) =>
      salvarAssinatura(u(req).escritorio_id, z.object({ imagem: z.string().nullable() }).parse(req.body).imagem));
    api.post('/api/notas/:id/email', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      const { para, tipo } = z.object({ para: ListaEmails, tipo: z.enum(['emissao', 'cancelamento']).default('emissao') }).parse(req.body);
      return enviarNotaPorEmail(id, u(req).escritorio_id, para, u(req).id, tipo);
    });
    api.get('/api/notas/:id/emails', async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      return historicoEmails(id);
    });

    /** Download em lote: ZIP com XML e/ou PDF (DANFSe) das notas autorizadas/canceladas do filtro. */
    api.get('/api/notas-lote', async (req, reply) => {
      const q = req.query as any;
      const usr = u(req);
      const filtros: string[] = ['e.escritorio_id = ?', "n.xml_nfse IS NOT NULL"];
      const params: unknown[] = [usr.escritorio_id];
      if (restritoAEmpresas(usr)) { filtros.push('e.id IN (SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?)'); params.push(usr.id); }
      if (!q.empresaId) throw new ErroNegocio('Escolha a empresa.');
      filtros.push('n.empresa_id = ?'); params.push(Number(q.empresaId));
      if (q.mes) { filtros.push('substr(n.competencia, 1, 7) = ?'); params.push(String(q.mes)); }
      if (q.status) { filtros.push('n.status = ?'); params.push(String(q.status)); }
      const formato = ['xml', 'pdf', 'ambos'].includes(q.formato) ? q.formato : 'ambos';
      const notas = db.prepare(`SELECT n.id, n.n_nfse, n.xml_nfse FROM notas n JOIN empresas e ON e.id = n.empresa_id
        WHERE ${filtros.join(' AND ')} ORDER BY n.id LIMIT 1000`).all(...params) as { id: number; n_nfse: string; xml_nfse: string }[];
      if (!notas.length) throw new ErroNegocio('Nenhuma nota autorizada neste filtro.', 404);
      const arquivos: Record<string, Uint8Array> = {};
      for (const n of notas) {
        const base = `NFSe_${n.n_nfse}`;
        if (formato !== 'pdf') arquivos[`${base}.xml`] = strToU8(n.xml_nfse);
        if (formato !== 'xml') arquivos[`${base}.pdf`] = await danfse(n.id);
      }
      const zip = Buffer.from(zipSync(arquivos, { level: 6 }));
      const nome = `notas-${q.mes ?? 'todas'}-${q.empresaId}.zip`;
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${nome}"`).send(zip);
    });

    /** Importa a NFS-e emitida no portal (Emissor Nacional) por empresas sem certificado. */
    api.post('/api/empresas/:id/notas/importar-xml', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const { xml } = z.object({ xml: z.string().min(200) }).parse(req.body);
      return importarNotaXml(id, u(req).id, xml);
    });

    api.get('/api/notas/:id', async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      const { xml_dps, xml_nfse, ...n } = obterNota(id)!;
      return n;
    });

    api.post('/api/notas', async (req) => {
      const entrada = EntradaEmissao.parse(req.body);
      checarEmpresa(req, entrada.empresaId);
      exigirLicenca();
      if (entrada.orcamentoId) conferirAntesDeEmitir(entrada.empresaId, entrada.orcamentoId, entrada.orcamentoItemId, entrada.valor);
      const nota = await emitir(u(req), entrada);
      if (entrada.orcamentoId && nota?.id) vincularNota(entrada.empresaId, entrada.orcamentoId, entrada.orcamentoItemId, nota.id, entrada.valor);
      return nota;
    });

    // ---- orçamentos de serviços ----
    const idEmp = (req: FastifyRequest) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return id; };
    const idOrc = (req: FastifyRequest) => Number((req.params as any).oid);
    api.get('/api/empresas/:id/orcamentos', async (req) => listarOrcamentos(idEmp(req)));
    api.post('/api/empresas/:id/orcamentos', async (req) => criarOrcamento(idEmp(req), u(req).id, EntradaOrcamento.parse(req.body)));
    api.get('/api/empresas/:id/orcamentos/:oid', async (req) => obterOrcamento(idEmp(req), idOrc(req)));
    api.put('/api/empresas/:id/orcamentos/:oid', async (req) => atualizarOrcamento(idEmp(req), idOrc(req), EntradaOrcamento.parse(req.body)));
    api.delete('/api/empresas/:id/orcamentos/:oid', async (req) => excluirOrcamento(idEmp(req), idOrc(req)));
    api.post('/api/empresas/:id/orcamentos/:oid/duplicar', async (req) => duplicarOrcamento(idEmp(req), u(req).id, idOrc(req)));
    api.post('/api/empresas/:id/orcamentos/:oid/situacao', async (req) => {
      const b = z.object({ acao: z.enum(['ENVIADO', 'APROVADO', 'RECUSADO', 'REABRIR']), motivo: z.string().trim().max(500).nullish() }).parse(req.body);
      return mudarSituacao(idEmp(req), idOrc(req), b.acao, b.motivo);
    });
    api.get('/api/empresas/:id/orcamentos/:oid/conversao', async (req) => {
      const q = z.object({ item: z.coerce.number().int().optional(), valor: z.coerce.number().optional() }).parse(req.query);
      return conversao(idEmp(req), idOrc(req), q.item ?? null, q.valor ?? null);
    });
    api.get('/api/empresas/:id/orcamentos/:oid/pdf', async (req, reply) => {
      const { pdf, nome } = await orcamentoPdf(idEmp(req), idOrc(req));
      return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${nome}"`).send(pdf);
    });
    api.post('/api/empresas/:id/orcamentos/:oid/email', async (req) => {
      const empresaId = idEmp(req);
      const b = z.object({ para: ListaEmails }).parse(req.body);
      await enviarOrcamentoPorEmail(u(req).escritorio_id, empresaId, idOrc(req), b.para);
      return obterOrcamento(empresaId, idOrc(req)).faturado > 0 ? obterOrcamento(empresaId, idOrc(req)) : mudarSituacao(empresaId, idOrc(req), 'ENVIADO');
    });

    // "Um comando": nota + boleto + e-mail conforme o cadastro do cliente
    api.post('/api/faturar', async (req) => {
      const entrada = EntradaFaturamento.parse(req.body);
      checarEmpresa(req, entrada.empresaId);
      if (entrada.orcamentoId) conferirAntesDeEmitir(entrada.empresaId, entrada.orcamentoId, entrada.orcamentoItemId, entrada.valor);
      const r = await faturar(u(req), entrada);
      if (entrada.orcamentoId && r.nota?.id) vincularNota(entrada.empresaId, entrada.orcamentoId, entrada.orcamentoItemId, r.nota.id, entrada.valor);
      return r;
    });

    api.get('/api/empresas/:id/contabilidade/config', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return configFechamento(id); });
    api.put('/api/empresas/:id/contabilidade/config', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      salvarFechamento(id, ConfigFechamento.parse(req.body)); return configFechamento(id);
    });
    api.post('/api/empresas/:id/contabilidade/enviar', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const { mes } = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.body ?? {});
      return enviarFechamento(id, mes ?? mesAnterior(new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)));
    });

    // ---------- Relatórios ----------
    api.get('/api/relatorios', async () => catalogo());
    api.get('/api/empresas/:id/relatorios/:rel', async (req, reply) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const q = z.object({
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tomadorId: z.coerce.number().int().optional(), situacao: z.string().max(20).optional(), formato: z.enum(['json', 'csv', 'pdf']).default('json'),
      }).parse(req.query);
      const r = gerarRelatorio(id, (req.params as any).rel, { de: q.de, ate: q.ate, tomadorId: q.tomadorId ?? null, situacao: q.situacao || null });
      const nome = `${r.id}_${q.de}_${q.ate}`;
      if (q.formato === 'csv') return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${nome}.csv"`).send(relatorioCsv(r));
      if (q.formato === 'pdf') {
        return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${nome}.pdf"`).send(await relatorioPdf(r, emitenteDaEmpresa(id)));
      }
      return r;
    });

    // ---------- Emissão automática (agenda mensal por cliente) ----------
    const mesAgenda = z.string().regex(/^\d{4}-\d{2}$/);
    api.get('/api/empresas/:id/agenda', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const mes = mesAgenda.catch(new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7)).parse((req.query as any).mes);
      return { mes, itens: listarAgenda(id, mes), resumo: resumoAgenda(id, mes) };
    });
    api.post('/api/empresas/:id/agenda/config', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ tomadorId: z.number().int(), ativa: z.boolean(), dia: z.number().int().nullish() }).parse(req.body);
      configurarAgenda(id, d.tomadorId, d.ativa, d.dia ?? null); return { ok: true };
    });
    api.post('/api/empresas/:id/agenda/executar', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ tomadorId: z.number().int(), servicoId: z.number().int(), mes: mesAgenda }).parse(req.body);
      return executarItem(u(req), id, d.tomadorId, d.servicoId, d.mes);
    });
    api.post('/api/empresas/:id/agenda/executar-todas', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return executarProntas(u(req), id, z.object({ mes: mesAgenda }).parse(req.body).mes);
    });
    api.post('/api/empresas/:id/agenda/pular', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ tomadorId: z.number().int(), servicoId: z.number().int(), mes: mesAgenda, desfazer: z.boolean().default(false) }).parse(req.body);
      pularItem(id, d.tomadorId, d.servicoId, d.mes, d.desfazer); return { ok: true };
    });

    api.post('/api/empresas/:id/boleto-avulso', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return gerarBoletoAvulso(u(req), id, BoletoAvulso.parse(req.body));
    });
    api.get('/api/empresas/:id/cobrancas', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return listarCobrancas(id);
    });

    // ---- cobrança bancária (remessa e retorno) ----
    const cobrancaDoUsuario = (req: FastifyRequest, id: number) => {
      const c = obterCobranca(id);
      if (!c) throw new ErroNegocio('Cobrança não encontrada.', 404);
      checarEmpresa(req, c.empresa_id);
      return c;
    };
    api.get('/api/empresas/:id/conta-bancaria', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return obterConta(id) ?? null;
    });
    api.put('/api/empresas/:id/conta-bancaria', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return salvarConta(id, ContaBancaria.parse(req.body));
    });
    api.get('/api/empresas/:id/cora', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return obterContaCora(id);
    });
    api.put('/api/empresas/:id/cora', { preHandler: exigirPapel('admin', 'operador'), bodyLimit: 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return salvarContaCora(id, ContaCoraEntrada.parse(req.body));
    });
    api.delete('/api/empresas/:id/cora', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      removerContaCora(id); return { ok: true };
    });
    api.post('/api/empresas/:id/cora/testar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return testarCora(id);
    });
    api.post('/api/empresas/:id/cora/sincronizar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return sincronizarTudo(id, true);
    });
    api.get('/api/cobrancas/:id/boleto', async (req, reply) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      const { pdf, nome } = await boletoPdf(id);
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${nome}"`).send(pdf);
    });
    api.get('/api/cobrancas/:id/carta', async (req, reply) => {
      const id = Number((req.params as any).id);
      const c = cobrancaDoUsuario(req, id) as any;
      const { pdf, nome } = await cartaCobrancaPdf(c.empresa_id, c.tomador_id);
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${nome}"`).send(pdf);
    });
    api.get('/api/cobrancas/:id/demonstrativo', async (req, reply) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      const { pdf, nome } = await demonstrativoPdf(id);
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${nome}"`).send(pdf);
    });
    api.get('/api/empresas/:id/pix-config', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return configPixPublica(id); });
    api.put('/api/empresas/:id/pix-config', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return salvarConfigPix(id, ConfigPix.parse(req.body));
    });
    api.post('/api/empresas/:id/pix-gerar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return gerarPixPendentes(id); });
    // QR Code do Pix da cobrança (PNG), para baixar e mandar ao cliente
    api.get('/api/cobrancas/:id/qrcode', async (req, reply) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      const c = obterCobranca(id);
      if (!c?.pix_copia_cola) throw new ErroNegocio('Esta cobrança ainda não tem Pix.');
      const QRCode = (await import('qrcode')).default;
      const png = await QRCode.toBuffer(c.pix_copia_cola, { errorCorrectionLevel: 'M', margin: 2, width: 640 });
      const nome = `Pix_${String(c.tomador_nome ?? 'cobranca').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${c.vencimento}.png`;
      return reply.type('image/png').header('Content-Disposition', `attachment; filename="${nome}"`).send(png);
    });
    api.post('/api/cobrancas/:id/pix/gerar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      return gerarPixCobranca(id);
    });
    api.post('/api/cobrancas/:id/pix', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      return informarPix(id, z.object({ codigo: z.string().max(1000) }).parse(req.body).codigo);
    });
    api.post('/api/cobrancas/:id/email', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      return enviarCobrancaPorEmail(u(req).escritorio_id, id);
    });
    api.get('/api/empresas/:id/demonstrativo', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return { rodape: (db.prepare('SELECT demonstrativo_rodape FROM empresas WHERE id = ?').get(id) as any)?.demonstrativo_rodape ?? '' };
    });
    api.put('/api/empresas/:id/demonstrativo', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ rodape: z.string().trim().max(120) }).parse(req.body);
      db.prepare('UPDATE empresas SET demonstrativo_rodape = ? WHERE id = ?').run(d.rodape || null, id); return { ok: true };
    });
    api.post('/api/cobrancas/:id/cancelar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      return (cobrancaDoUsuario(req, id) as any).cora_id ? cancelarNaCora(id) : cancelarCobranca(id);
    });
    api.post('/api/cobrancas/:id/reemitir', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      const d = z.object({ vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe o vencimento'), valor: z.number().positive().nullish() }).parse(req.body);
      exigirLicenca();
      const antiga = obterCobranca(id);
      if (antiga?.cora_id && antiga.status !== 'PAGO' && antiga.status !== 'CANCELADO') await cancelarNaCora(id); // a Cora não altera boleto: cancela e emite outro
      return reemitirCobranca(u(req).id, id, d.vencimento, d.valor);
    });
    api.get('/api/empresas/:id/modelos-whatsapp', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return obterModelosWhatsapp(id);
    });
    api.put('/api/empresas/:id/modelos-whatsapp', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      salvarModelosWhatsapp(id, z.object({ lembrete: z.string().max(1000), atraso: z.string().max(1000) }).parse(req.body)); return { ok: true };
    });
    api.post('/api/cobrancas/:id/pagar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      cobrancaDoUsuario(req, id);
      const d = z.object({ data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), valor: z.number().positive().nullish() }).parse(req.body ?? {});
      marcarPago(id, d.data ?? undefined, d.valor ?? undefined);
      return { ok: true };
    });
    api.get('/api/empresas/:id/remessas', async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return listarRemessas(id);
    });
    api.post('/api/empresas/:id/remessas', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      return gerarRemessaEmpresa(id, u(req).id);
    });
    api.get('/api/remessas/:id/arquivo', async (req, reply) => {
      const r = obterRemessa(Number((req.params as any).id));
      if (!r) throw new ErroNegocio('Remessa não encontrada.', 404);
      checarEmpresa(req, r.empresa_id);
      return reply.type('text/plain; charset=latin1').header('Content-Disposition', `attachment; filename="${r.nome_arquivo}"`).send(Buffer.from(r.conteudo, 'latin1'));
    });
    api.post('/api/empresas/:id/retorno', { preHandler: exigirPapel('admin', 'operador'), bodyLimit: 10 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id);
      checarEmpresa(req, id);
      const d = z.object({ conteudo: z.string().min(240) }).parse(req.body);
      return processarRetorno(id, d.conteudo);
    });

    api.get('/api/licenca', async () => ({ ...statusLicenca(), modulosPagos: Object.fromEntries(Object.entries(MODULOS_PAGOS).filter(([, m]) => !m.emBreve).map(([k, m]) => [k, { nome: m.nome, resumo: m.resumo }])), planos: PLANOS, uso: usoAtual(), suporteWhatsapp: SUPORTE_WHATSAPP }));
    api.post('/api/licenca', { preHandler: exigirPapel('admin') }, async (req) => {
      const d = z.object({ codigo: z.string().min(10) }).parse(req.body);
      return ativarLicenca(d.codigo);
    });

    api.post('/api/notas/:id/reenviar', async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      exigirLicenca();
      const corpo = req.body && Object.keys(req.body as object).length ? EntradaEmissao.parse(req.body) : undefined;
      if (corpo) checarEmpresa(req, corpo.empresaId);
      return enviar(id, corpo);
    });

    api.post('/api/notas/:id/reconciliar', async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      return reconciliar(id);
    });

    api.delete('/api/notas/:id', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      return excluirNota(id);
    });

    api.post('/api/notas/:id/cancelar', { preHandler: exigirPapel('admin', 'operador') }, async (req) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      exigirLicenca();
      const d = z.object({ cMotivo: z.union([z.literal(1), z.literal(2), z.literal(9)]), xMotivo: z.string() }).parse(req.body);
      return cancelar(u(req), id, d.cMotivo, d.xMotivo);
    });

    api.get('/api/notas/:id/danfse', async (req, reply) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      const pdf = await danfse(id);
      const n = db.prepare('SELECT n_nfse FROM notas WHERE id = ?').get(id) as any;
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="DANFSe_${n.n_nfse}.pdf"`).send(pdf);
    });

    api.get('/api/notas/:id/xml', async (req, reply) => {
      const id = Number((req.params as any).id);
      notaDoUsuario(req, id);
      const n = db.prepare('SELECT xml_nfse, xml_dps, n_nfse, n_dps FROM notas WHERE id = ?').get(id) as any;
      const xml = n.xml_nfse ?? n.xml_dps;
      if (!xml) throw new ErroNegocio('Nota sem XML.', 404);
      const nome = n.xml_nfse ? `NFSe_${n.n_nfse}.xml` : `DPS_${n.n_dps}.xml`;
      return reply.type('application/xml').header('Content-Disposition', `attachment; filename="${nome}"`).send(xml);
    });

    // ---------- Extrato bancário (PDF), classificação e conciliação ----------
    api.post('/api/empresas/:id/extrato/importar', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ nome: z.string().max(200).default('extrato.pdf'), pdfBase64: z.string().min(100) }).parse(req.body);
      const pdf = Buffer.from(d.pdfBase64, 'base64');
      if (pdf.subarray(0, 4).toString() !== '%PDF') throw new ErroNegocio('O arquivo não é um PDF.');
      return importarExtrato(id, d.nome, pdf);
    });
    api.get('/api/empresas/:id/extrato', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const mes = (req.query as any).mes;
      return extratoDoMes(id, /^\d{4}-\d{2}$/.test(mes) ? mes : new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7));
    });
    api.get('/api/empresas/:id/extrato/balanco', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const q = z.object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
      return balancoExtrato(id, q.de, q.ate);
    });
    api.put('/api/empresas/:id/extrato/:lid', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      classificar(Number(p.id), Number(p.lid), Classificacao.parse(req.body)); return { ok: true };
    });
    api.get('/api/empresas/:id/extrato/:lid/boletos', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      return candidatosBoleto(Number(p.id), Number(p.lid));
    });
    api.get('/api/empresas/:id/extrato/:lid/despesas', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      return candidatosDespesa(Number(p.id), Number(p.lid));
    });
    api.post('/api/empresas/:id/extrato/:lid/despesa', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      const d = z.object({ despesaId: z.number().int().nullable() }).parse(req.body);
      ligarDespesa(Number(p.id), Number(p.lid), d.despesaId); return { ok: true };
    });
    api.post('/api/empresas/:id/extrato/:lid/conciliar', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      const d = z.object({ cobrancaId: z.number().int().nullable(), darBaixa: z.boolean().default(false) }).parse(req.body);
      conciliar(Number(p.id), Number(p.lid), d.cobrancaId, d.darBaixa); return { ok: true };
    });
    api.delete('/api/empresas/:id/extrato/importacoes/:iid', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      excluirImportacao(Number(p.id), Number(p.iid)); return { ok: true };
    });

    // ---------- Fatura do cartão de crédito (PDF) ----------
    api.post('/api/empresas/:id/cartao/importar', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const d = z.object({ nome: z.string().max(200).default('fatura.pdf'), pdfBase64: z.string().min(100) }).parse(req.body);
      const pdf = Buffer.from(d.pdfBase64, 'base64');
      if (pdf.subarray(0, 4).toString() !== '%PDF') throw new ErroNegocio('O arquivo não é um PDF.');
      return importarFatura(id, d.nome, pdf);
    });
    api.get('/api/empresas/:id/cartao', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const mes = (req.query as any).mes;
      return faturasDoMes(id, /^\d{4}-\d{2}$/.test(mes) ? mes : new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7));
    });
    api.put('/api/empresas/:id/cartao/:lid', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      classificarCartao(Number(p.id), Number(p.lid), ClassificacaoCartao.parse(req.body)); return { ok: true };
    });
    api.delete('/api/empresas/:id/cartao/faturas/:fid', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      excluirFatura(Number(p.id), Number(p.fid)); return { ok: true };
    });

    /** Pacote para a contabilidade: XML/PDF das notas do período e OFX da movimentação. */
    api.get('/api/contabilidade/exportar', async (req, reply) => {
      const q = z.object({
        empresaId: z.coerce.number().int(),
        de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        xml: z.enum(['0', '1']).default('1'), pdf: z.enum(['0', '1']).default('1'), ofx: z.enum(['0', '1']).default('1'), entradas: z.enum(['0', '1']).default('1'), sefaz: z.enum(['0', '1']).default('1'),
      }).parse(req.query);
      checarEmpresa(req, q.empresaId);
      const r = await pacoteContabilidade(q.empresaId, { de: q.de, ate: q.ate, xml: q.xml === '1', pdf: q.pdf === '1', ofx: q.ofx === '1', entradas: q.entradas === '1', sefaz: q.sefaz === '1' });
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${r.nome}"`).send(r.zip);
    });

    // ---------- Relatórios ----------
    api.get('/api/relatorios/resumo', async (req) => {
      const q = req.query as any;
      const usr = u(req);
      const mes = q.mes ?? new Date().toISOString().slice(0, 7);
      const filtroCliente = restritoAEmpresas(usr) ? 'AND e.id IN (SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?)' : '';
      const params: unknown[] = [mes, usr.escritorio_id, ...(restritoAEmpresas(usr) ? [usr.id] : [])];
      return db.prepare(`SELECT e.id AS empresa_id, e.razao_social AS empresa,
          SUM(n.status = 'AUTORIZADA') AS autorizadas, SUM(n.status = 'CANCELADA') AS canceladas,
          SUM(n.status IN ('REJEITADA','ERRO_COMUNICACAO','PENDENTE')) AS pendencias,
          ROUND(SUM(CASE WHEN n.status = 'AUTORIZADA' THEN n.valor_servico ELSE 0 END), 2) AS faturado
        FROM empresas e LEFT JOIN notas n ON n.empresa_id = e.id AND substr(n.competencia,1,7) = ? AND n.ambiente = e.ambiente
        WHERE e.escritorio_id = ? ${filtroCliente} GROUP BY e.id ORDER BY faturado DESC`).all(...params);
    });

    // ---------- Painel financeiro, despesas e balanço ----------
    const mesDe = (v: unknown) => z.string().regex(/^\d{4}-\d{2}$/).catch(new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7)).parse(v);
    api.get('/api/empresas/:id/painel', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return painelFinanceiro(id, mesDe((req.query as any).mes));
    });
    api.get('/api/empresas/:id/despesas', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const mes = mesDe((req.query as any).mes);
      return { mes, categorias: listarCategorias(id), despesas: listarDespesas(id, mes) };
    });
    api.post('/api/empresas/:id/despesas', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return { id: criarDespesa(id, u(req).id, Despesa.parse(req.body)) };
    });
    api.put('/api/empresas/:id/despesas/:did', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      editarDespesa(Number(p.id), Number(p.did), Despesa.parse(req.body)); return { ok: true };
    });
    api.delete('/api/empresas/:id/despesas/:did', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      excluirDespesa(Number(p.id), Number(p.did)); return { ok: true };
    });
    // ---------- Tributação: impostos, perfis e tipos de documento ----------
    api.get('/api/tributacao/impostos', async () => listarImpostos());
    api.put('/api/tributacao/impostos/:codigo', async (req) => { editarImposto(String((req.params as any).codigo), EdicaoImposto.parse(req.body)); return { ok: true }; });
    api.get('/api/empresas/:id/tributacao/perfis', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return listarTributacoes(id); });
    api.post('/api/empresas/:id/tributacao/perfis', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return criarTributacao(id, Tributacao.parse(req.body)); });
    api.put('/api/empresas/:id/tributacao/perfis/:pid', async (req) => { const p = req.params as any; checarEmpresa(req, Number(p.id)); editarTributacao(Number(p.id), Number(p.pid), Tributacao.parse(req.body)); return { ok: true }; });
    api.delete('/api/empresas/:id/tributacao/perfis/:pid', async (req) => { const p = req.params as any; checarEmpresa(req, Number(p.id)); excluirTributacao(Number(p.id), Number(p.pid)); return { ok: true }; });
    api.get('/api/empresas/:id/tributacao/tipos/:tid/efetiva', async (req) => {
      const p = req.params as any; checarEmpresa(req, Number(p.id));
      const { data } = z.object({ data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
      const ef = tributacaoEfetiva(Number(p.tid), data);
      const t = db.prepare('SELECT empresa_id FROM tipos_documento WHERE id = ?').get(Number(p.tid)) as any;
      if (!ef || t.empresa_id !== Number(p.id)) throw new ErroNegocio('Tipo de documento não encontrado.', 404);
      return ef;
    });
    api.get('/api/empresas/:id/tributacao/tipos', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return { tipos: listarTipos(id), naturezas: NATUREZAS }; });
    api.post('/api/empresas/:id/tributacao/tipos', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return criarTipo(id, TipoDocumento.parse(req.body)); });
    api.put('/api/empresas/:id/tributacao/tipos/:tid', async (req) => { const p = req.params as any; checarEmpresa(req, Number(p.id)); editarTipo(Number(p.id), Number(p.tid), TipoDocumento.parse(req.body)); return { ok: true }; });
    api.delete('/api/empresas/:id/tributacao/tipos/:tid', async (req) => { const p = req.params as any; checarEmpresa(req, Number(p.id)); excluirTipo(Number(p.id), Number(p.tid)); return { ok: true }; });
    api.post('/api/empresas/:id/tributacao/gerar-dos-servicos', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return gerarPerfisDosServicos(id); });

    // ---------- Compras (NF-e de entrada) ----------
    const compraDoUsuario = (req: FastifyRequest, id: number) => {
      const c = db.prepare('SELECT empresa_id FROM compras WHERE id = ?').get(id) as { empresa_id: number } | undefined;
      if (!c) throw new ErroNegocio('Compra não encontrada.', 404);
      checarEmpresa(req, c.empresa_id);
    };
    api.get('/api/empresas/:id/compras', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const f = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional(), q: z.string().max(80).optional(), de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
      return listarCompras(id, f.mes ?? null, f);
    });
    api.post('/api/empresas/:id/compras/importar-xml', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return importarCompraXml(id, u(req).id, OpcoesImportacao.parse(req.body));
    });
    api.get('/api/empresas/:id/compras/fornecedores', async (req) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return fornecedoresDaEmpresa(id); });
    api.post('/api/empresas/:id/compras/previa-xml', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return previaCompraXml(id, z.object({ xml: z.string().min(200) }).parse(req.body).xml);
    });
    api.put('/api/compras/:id/parcelas', async (req) => {
      const id = Number((req.params as any).id); compraDoUsuario(req, id);
      return alterarParcelas(id, u(req).id, z.object({ parcelas: z.array(ParcelaEditada).min(1).max(60) }).parse(req.body).parcelas);
    });
    api.get('/api/empresas/:id/compras/sefaz/previa/:chave', async (req) => {
      const id = empresaDaRota(req);
      return previaCompraXml(id, xmlRecebida(id, Chave.parse((req.params as any).chave)).xml);
    });
    api.post('/api/empresas/:id/compras', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return criarCompraManual(id, u(req).id, CompraManual.parse(req.body));
    });
    api.get('/api/compras/:id', async (req) => { const id = Number((req.params as any).id); compraDoUsuario(req, id); return obterCompra(id); });
    api.get('/api/compras/:id/xml', async (req, reply) => {
      const id = Number((req.params as any).id); compraDoUsuario(req, id);
      const { xml, nome } = xmlDaCompra(id);
      return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${nome}"`).send(xml);
    });
    // ---------- Compras: NF-e recebidas direto da SEFAZ (Distribuição DF-e) ----------
    const empresaDaRota = (req: FastifyRequest) => { const id = Number((req.params as any).id); checarEmpresa(req, id); return id; };
    const Chave = z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().length(44, 'A chave de acesso precisa ter 44 dígitos'));
    api.get('/api/empresas/:id/compras/sefaz', async (req) => {
      const { todas } = z.object({ todas: z.string().optional() }).parse(req.query);
      return listarRecebidas(empresaDaRota(req), { todas: todas === '1' });
    });
    api.post('/api/empresas/:id/compras/sefaz/buscar', async (req) => buscarNaSefaz(empresaDaRota(req)));
    api.post('/api/empresas/:id/compras/sefaz/chave', async (req) => {
      const id = empresaDaRota(req);
      return { nota: await buscarPorChave(id, z.object({ chave: Chave }).parse(req.body).chave) };
    });
    api.post('/api/empresas/:id/compras/sefaz/importar', async (req) => {
      const id = empresaDaRota(req);
      return importarRecebidas(id, u(req).id, ImportacaoRecebidas.parse(req.body));
    });
    api.post('/api/empresas/:id/compras/sefaz/ocultar', async (req) => {
      const id = empresaDaRota(req);
      const b = z.object({ chave: Chave, oculta: z.boolean() }).parse(req.body);
      return ocultarRecebida(id, b.chave, b.oculta);
    });
    api.post('/api/empresas/:id/compras/sefaz/ciencia', async (req) => {
      const id = empresaDaRota(req);
      liberarCiencias(id, z.object({ chaves: z.array(Chave).max(200).optional() }).parse(req.body ?? {}).chaves);
      return buscarNaSefaz(id);
    });
    api.put('/api/empresas/:id/compras/sefaz/config', async (req) => {
      const id = empresaDaRota(req);
      return configurarBusca(id, z.object({ automatica: z.boolean() }).parse(req.body).automatica);
    });
    api.get('/api/empresas/:id/compras/sefaz/xml/:chave', async (req, reply) => {
      const id = empresaDaRota(req);
      const { xml, nome } = xmlRecebida(id, Chave.parse((req.params as any).chave));
      return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${nome}"`).send(xml);
    });
    // Conexão com a SEFAZ (cadeia ICP-Brasil): só administradores
    api.get('/api/sefaz/conexao', async () => statusConfianca());
    api.put('/api/sefaz/conexao', async (req) => {
      definirVerificacaoServidor(z.object({ verificarServidor: z.boolean() }).parse(req.body).verificarServidor);
      return statusConfianca();
    });
    api.post('/api/sefaz/conexao/baixar-cadeia', async () => {
      const r = await baixarCadeiaIcp();
      if (r.falhas.length && !r.guardados) {
        throw new ErroNegocio(`Não foi possível atualizar pelo site do ITI: ${r.falhas.join('; ')}. A cadeia embutida no sistema continua valendo; se precisar, baixe o arquivo pelo navegador e envie aqui.`, 502);
      }
      return { ...statusConfianca(), guardados: r.guardados, lidos: r.lidos };
    });
    api.post('/api/sefaz/conexao/cadeia', async (req) => {
      let dados: Buffer | null = null;
      for await (const parte of req.parts({ limits: { fileSize: 10 * 1024 * 1024 } })) if (parte.type === 'file') dados = await parte.toBuffer();
      if (!dados) throw new ErroNegocio('Envie o arquivo da cadeia de certificados.');
      const pems = extrairCertificadosAc(dados);
      if (!pems.length) throw new ErroNegocio('Não encontrei certificados de autoridade (AC) neste arquivo. Use o .zip ou .crt/.cer/.p7b da cadeia ICP-Brasil.');
      guardarCadeiaIcp(pems);
      return { ...statusConfianca(), lidos: pems.length };
    });
    api.delete('/api/sefaz/conexao/cadeia', async () => { apagarCadeiaIcp(); return statusConfianca(); });

    api.delete('/api/compras/:id', async (req) => { const id = Number((req.params as any).id); compraDoUsuario(req, id); return excluirCompra(id); });

    api.put('/api/empresas/:id/despesas-categorias', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      salvarCategorias(id, z.object({ categorias: z.array(z.string()) }).parse(req.body).categorias); return { ok: true };
    });
    api.get('/api/empresas/:id/feriados', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      return { feriados_extra: (db.prepare('SELECT feriados_extra FROM empresas WHERE id = ?').get(id) as any)?.feriados_extra ?? '' };
    });
    api.put('/api/empresas/:id/feriados', async (req) => {
      const id = Number((req.params as any).id); checarEmpresa(req, id);
      const t = z.object({ feriados_extra: z.string().max(200) }).parse(req.body).feriados_extra;
      const lista = t.split(/[,;\s]+/).filter(Boolean);
      if (lista.some((x) => !/^(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])$/.test(x))) throw new ErroNegocio('Use datas no formato dia/mês separadas por vírgula, por exemplo: 24/06, 19/03.');
      db.prepare('UPDATE empresas SET feriados_extra = ? WHERE id = ?').run(lista.join(', ') || null, id); return { ok: true };
    });

    // ---------- Consulta pública de CNPJ ----------
    api.get('/api/consulta/cnpj/:cnpj', async (req) => consultarCnpj((req.params as any).cnpj));

    // ---------- Backup ----------
    api.get('/api/backup', { preHandler: exigirPapel('admin') }, async () => ({ automaticos: listarBackups(), pasta: config.backupDir }));

    /** Gera uma cópia consistente do banco e entrega como download. */
    api.get('/api/backup/baixar', { preHandler: exigirPapel('admin') }, async (_req, reply) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-bkp-'));
      const arquivo = criarBackup(dir, 'backup.db');
      const dados = fs.readFileSync(arquivo);
      fs.rmSync(dir, { recursive: true, force: true });
      const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
      return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="nfse-backup-${dia}.db"`).send(dados);
    });

    api.get('/api/tabelas', async () => ({ motivosCancelamento: MOTIVOS_CANCELAMENTO }));
  });
}
