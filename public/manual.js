/**
 * Manual do usuário do Kontor Gestão Empresas (mostrado em Relatórios > Documentação).
 * REGRA DO PROJETO: toda funcionalidade nova ou alterada precisa atualizar o tópico correspondente
 * aqui (e a data/versão em MANUAL_VERSAO) antes de publicar a versão.
 * `corpo` é HTML escrito à mão (não recebe dados de usuário).
 */
export const MANUAL_VERSAO = '1.0.5';

export const MANUAL = [
  {
    id: 'primeiros-passos', titulo: 'Primeiros passos', resumo: 'Instalação, primeiro acesso e o que configurar antes de emitir.',
    corpo: `
      <p>O Kontor Gestão Empresas emite NFS-e pelo <strong>Emissor Nacional</strong> (Sefin Nacional), para várias empresas ao mesmo tempo, e cuida de boletos, despesas, extrato e relatórios.</p>
      <h3>Antes da primeira nota</h3>
      <ol>
        <li><strong>Primeiro acesso:</strong> informe o nome do escritório e crie o usuário administrador.</li>
        <li><strong>Licença:</strong> em Configurações &gt; Licença, cole o código recebido para liberar a emissão.</li>
        <li><strong>Empresa:</strong> em Empresas, cadastre cada prestador (CNPJ, regime, município, ambiente).</li>
        <li><strong>Certificado A1:</strong> na linha da empresa, botão Certificado (arquivo .pfx e senha). Empresas que emitem só pelo portal com CNPJ e senha não precisam dele (veja <em>Empresas</em>).</li>
        <li><strong>Serviços e clientes:</strong> cadastre os serviços prestados e os clientes (tomadores).</li>
        <li><strong>Teste:</strong> mantenha a empresa em <em>Produção restrita (testes)</em> até validar tudo; só depois mude o ambiente para produção.</li>
      </ol>
      <h3>Como o sistema é organizado</h3>
      <p>No alto do menu lateral fica a <strong>empresa selecionada</strong>: quase todas as telas mostram os dados dela. Troque a empresa ali a qualquer momento. O restante do menu segue o fluxo do dia a dia: emitir, acompanhar notas, cobrar, controlar despesas e consultar relatórios.</p>
      <p class="dica">O menu mostra só o que o seu usuário tem permissão de usar (Configurações &gt; Usuários e acessos). Este manual está liberado para todos os usuários: em Relatórios &gt; Documentação, ou no item Documentação do menu para quem não tem o acesso a Relatórios.</p>`,
  },
  {
    id: 'inicio', titulo: 'Início e lembretes', resumo: 'Tela de abertura com acesso rápido, dica e mensagem do dia; lembretes no sininho.',
    corpo: `
      <p>Ao abrir o programa, a tela <strong>Início</strong> mostra a saudação, a logo, o <strong>acesso rápido</strong> às telas mais usadas (conforme os acessos do usuário), a <strong>dica do dia</strong> e uma <strong>mensagem</strong> para o dia.</p>
      <p>Os <strong>lembretes</strong> ficam no <strong>sininho</strong>, no alto de todas as telas: cobranças vencidas e que vencem hoje, notas rejeitadas ou com erro nos últimos 15 dias e certificados digitais vencendo em até 30 dias. O número mostra quantos pedem ação (vermelho quando há algo atrasado); clique num lembrete para ir direto à tela. Ao lado do sininho fica o seu nome, com atalhos para <em>Minha conta</em>, <em>Aparência</em> e <em>Sair</em>.</p>`,
  },
  {
    id: 'empresas', titulo: 'Empresas', resumo: 'Cadastro do prestador, certificado, logo, dados bancários e emissão sem certificado.',
    corpo: `
      <h3>Cadastrar</h3>
      <p>Em <strong>Empresas &gt; Cadastrar empresa</strong> informe o CNPJ (o botão de busca preenche razão social e endereço), o regime (não optante, MEI ou Simples ME/EPP), o município e o ambiente. Use <em>Produção restrita</em> para testes: as notas não têm valor fiscal.</p>
      <h3>Certificado A1</h3>
      <p>A API da Sefin exige certificado digital A1 da empresa. Na linha da empresa, <strong>Certificado</strong> envia o arquivo .pfx e a senha; o sistema guarda criptografado e mostra a validade. Renove antes de vencer.</p>
      <h3>Emissão sem certificado (CNPJ e senha)</h3>
      <p>Para empresas que emitem direto no portal do Emissor Nacional, escolha o modo <strong>Portal (CNPJ e senha)</strong> no cadastro. Nesse modo o sistema <em>não emite a nota</em>: você emite no portal e importa o XML em <strong>Notas emitidas &gt; Importar XML</strong>. Os boletos, as cobranças e os relatórios continuam funcionando normalmente. A senha do portal fica guardada criptografada.</p>
      <h3>Logo</h3>
      <p>O botão <strong>Logo</strong> envia a imagem que aparece no DANFSe (PDF da nota) dessa empresa.</p>
      <h3>Dados bancários</h3>
      <p>O botão <strong>Dados bancários</strong> da linha da empresa abre a configuração da cobrança (convênio bancário com remessa e retorno): agência, conta, convênio, carteira, formato CNAB, numeração do próximo boleto e da próxima remessa, multa, juros, instrução e <em>feriados municipais</em>. Sem isso não é possível gerar boletos. Se já emitia boletos em outro sistema, informe o próximo número livre para o nosso número nunca repetir.</p>`,
  },
  {
    id: 'clientes', titulo: 'Clientes', resumo: 'Tomadores, forma de faturar, vencimento e serviços padrão.',
    corpo: `
      <p>Em <strong>Clientes</strong> ficam os tomadores de cada empresa. Informe o CNPJ/CPF (a busca preenche os dados), endereço e e-mail.</p>
      <h3>Importar clientes de uma planilha</h3>
      <p>Em <strong>Clientes → Importar planilha</strong>, envie um arquivo Excel (.xlsx) ou .csv com o <strong>CNPJ</strong> (ou CPF) e, se quiser, o nome, em qualquer coluna. O sistema mostra quantos são novos, quais já estão cadastrados, repetidos ou inválidos. Ao importar, ele <strong>consulta cada CNPJ na Receita Federal</strong> e preenche razão social, endereço, e-mail e telefone. CPF precisa do nome na planilha. CNPJ que o Excel mostrou sem o zero à esquerda é reconhecido.</p>
      <p>Todo cliente criado assim fica com a marca <strong>Falta conferir</strong>, com o motivo (endereço incompleto, sem e-mail, situação na Receita, Receita fora do ar). Use a aba <em>Falta conferir</em> da lista, complete o cadastro e marque <em>Cadastro conferido</em> para tirar a marca.</p>
      <h3>Como faturar</h3>
      <ul>
        <li><strong>Somente nota:</strong> emite a NFS-e.</li>
        <li><strong>Nota + boleto:</strong> emite a nota e gera o boleto.</li>
        <li><strong>Somente boleto:</strong> gera só a cobrança.</li>
      </ul>
      <h3>Vencimento</h3>
      <p>Por prazo (X dias após a emissão) ou em dia fixo do mês. Boleto não vence em sábado, domingo ou feriado: o sistema antecipa para o dia útil anterior.</p>
      <h3>Serviços padrão e agenda</h3>
      <p>Na aba <strong>Serviços padrão</strong> do cliente, cadastre o serviço e o valor que se repetem todo mês; eles alimentam a <em>Emissão automática</em>. Também é ali que se define o envio automático por e-mail.</p>`,
  },
  {
    id: 'servicos', titulo: 'Serviços e tributação', resumo: 'Cadastro do serviço, código nacional, NBS, retenções.',
    corpo: `
      <p>Em <strong>Serviços</strong> cadastre cada serviço prestado pela empresa selecionada: descrição que sai na nota, código de tributação nacional (cTribNac), alíquota e, se for o caso, NBS.</p>
      <h3>Tributação do serviço</h3>
      <p>O serviço <strong>não guarda</strong> alíquotas nem retenções: ele apenas aponta para uma <strong>tributação</strong> (campo <em>Tributação</em> do cadastro). Alíquota do ISS, ISSQN, imunidade, retenções (PIS, COFINS, CSLL, IRRF, INSS), totais aproximados, município e IBS/CBS ficam na tributação, em <strong>Tributação</strong>. Sem escolha, vale a tributação padrão de saída da empresa. Serviços antigos foram convertidos automaticamente.</p>
      <p class="dica">Confira sempre o enquadramento com o contador. O sistema só repete o que foi cadastrado.</p>`,
  },
  {
    id: 'emitir', titulo: 'Emitir nota', resumo: 'Passo a passo da emissão, F2 para clientes e boleto junto.',
    corpo: `
      <ol>
        <li>Abra <strong>Emitir nota</strong> (confira a empresa no alto do menu).</li>
        <li><strong>Cliente:</strong> comece a <strong>digitar o nome</strong> (ou o CNPJ/CPF): a lista se filtra enquanto você escreve; use as setas e Enter, ou clique no cliente. Apagar o campo volta para <em>Consumidor não identificado</em>. <kbd>F2</kbd> abre a consulta completa, em janela. Também dá para cadastrar um cliente novo ali mesmo.</li>
        <li><strong>Serviço:</strong> ao escolher, descrição e código são preenchidos e a <strong>tributação</strong> do serviço é selecionada.</li>
        <li><strong>Cliente com descrição composta:</strong> se o cliente tem esse modelo (aba <em>Descrição da nota</em> no cadastro), aparece um bloco com período, ordem de compra e o valor de cada linha (ex.: mão de obra e aluguel de máquinas). A descrição, o valor total e o INSS retido (só sobre as linhas marcadas) são calculados sozinhos; PIS, COFINS, CSLL e IR seguem o tributação, sobre o total.</li>
        <li><strong>Tributação:</strong> traz alíquota, ISSQN, retenções, totais aproximados, município e informações complementares (na data da competência). Trocar a tributação refaz o preenchimento; os campos ainda podem ser ajustados na nota.</li>
        <li><strong>Conferência da tributação:</strong> no fim do formulário, uma tabela mostra cada imposto com base, alíquota e valor (ISS, retenções federais, IBS/CBS informativo), o total retido e o <strong>líquido a receber</strong>, atualizada conforme você digita.</li>
        <li>Informe competência, valor e, se precisar, ajuste descrição e retenções.</li>
        <li>Se o cliente fatura com boleto, no bloco <strong>Pagamento / parcelamento</strong> (logo depois de Serviço e retenções, onde já está o líquido da NFS-e) defina o vencimento (já sugerido pela regra do cliente). Para <strong>parcelar</strong>, informe o número de parcelas (use <em>Dias entre parcelas</em> para intervalos fixos, como 15 ou 30 dias, ou a <em>Condição de pagamento</em>, como 30/60/90, que define sozinha as parcelas e os vencimentos a partir de hoje): o sistema divide o valor e sugere um vencimento por mês; ajuste data e valor de cada parcela (a soma precisa fechar com o boleto). Cada parcela vira um boleto, com o seu vencimento, e todos seguem no e-mail.</li>
        <li><strong>Emitir.</strong> O sistema monta a DPS, assina com o certificado e envia à Sefin.</li>
      </ol>
      <p><strong>Retenção dispensada:</strong> retenção de até R$ 10,00 não é feita, a cada pagamento: PIS + COFINS + CSLL são somados (Lei 10.833/2003, art. 31, § 3º) e o IRRF é avaliado à parte (Lei 9.430/1996, art. 67). O valor dispensado <em>não se acumula</em> com notas seguintes (Solução de Consulta RFB 258/2024). O sistema aplica isso ao calcular as retenções pelos percentuais e na emissão automática, e mostra “Dispensada” na conferência. Para reter mesmo assim, digite o valor retido.</p>
      <h3>Se algo der errado</h3>
      <ul>
        <li><strong>Clonar nota:</strong> na tela de qualquer nota emitida, o botão <em>Clonar nota</em> abre a emissão já preenchida (cliente, serviço, valor, descrição e tributação) com a competência de hoje. Confira os dados e emita: sai uma nota nova, com outro número.</li>
        <li><strong>Rejeitada:</strong> a tela da nota mostra o código e o motivo. Use <em>Corrigir e reenviar</em>; o número da DPS é mantido.</li>
        <li><strong>Sem resposta da Sefin:</strong> use <em>Consultar na Sefin</em> antes de reenviar; a nota pode já ter sido gerada e é recuperada sem duplicar.</li>
      </ul>
      <p class="dica">Em produção restrita as notas são de teste e não têm valor fiscal.</p>`,
  },
  {
    id: 'orcamentos', titulo: 'Orçamentos', resumo: 'Propostas de serviço que o cliente aprova e viram nota fiscal, inclusive em partes.',
    corpo: `
      <p>Em <strong>Orçamentos</strong> você monta a proposta de serviços para o cliente, envia, acompanha a resposta e, aprovada, transforma em nota fiscal.</p>
      <ol>
        <li><strong>Novo orçamento:</strong> escolha o cliente cadastrado (ou digite nome, e-mail e WhatsApp de quem ainda não é cliente), inclua um ou mais serviços com quantidade e valor, desconto, validade e condições.</li>
        <li><strong>Enviar:</strong> <em>Ver PDF</em> abre a proposta no papel timbrado da empresa; <em>Enviar por e-mail</em> manda o PDF anexo; <em>WhatsApp</em> abre a conversa com a mensagem pronta (baixe o PDF para anexar). Enviar marca o orçamento como Enviado.</li>
        <li><strong>Resposta do cliente:</strong> use <em>Cliente aprovou</em> ou <em>Cliente recusou</em> (com o motivo). Passada a validade sem resposta, o orçamento aparece como Vencido. <em>Voltar a rascunho</em> reabre a edição.</li>
        <li><strong>Converter em nota:</strong> escolha uma nota somando os serviços ou só um item e informe o valor. A tela de emissão abre preenchida para você conferir; o orçamento só é vinculado quando a nota é emitida.</li>
      </ol>
      <h3>Faturamento parcial</h3>
      <p>Para faturar em partes (sinal de 50%, por etapa), reduza o valor na conversão. O saldo continua no orçamento, que fica <strong>Faturado em parte</strong> até ser totalmente faturado. Nota rejeitada ou cancelada devolve o valor ao saldo.</p>
      <p class="dica">Orçamento com nota emitida não pode mais ser alterado nem excluído; para uma nova proposta, use <em>Duplicar</em>. Só orçamentos de serviços.</p>`,
  },
  {
    id: 'notas', titulo: 'Notas emitidas', resumo: 'Consultar, baixar, enviar, cancelar, excluir e importar XML.',
    corpo: `
      <p>A lista mostra as notas da empresa com situação, número, cliente e valor. Clique na nota para ver o detalhe.</p>
      <h3>O que dá para fazer</h3>
      <ul>
        <li><strong>Abrir DANFSe</strong> (PDF) e <strong>baixar o XML</strong>.</li>
        <li><strong>Consultar no portal nacional</strong>.</li>
        <li><strong>Enviar por e-mail</strong> ou WhatsApp ao cliente (só notas de produção).</li>
        <li><strong>Cancelar nota:</strong> só para nota autorizada, com motivo de pelo menos 15 caracteres. A nota fica <em>Cancelada</em> e continua no histórico.</li>
        <li><strong>Excluir nota:</strong> só para nota <em>não autorizada</em> (rejeitada, pendente ou sem resposta). Nota autorizada ou cancelada <u>nunca</u> pode ser excluída. Os boletos ligados continuam no sistema. Só aparece para o administrador e para usuários com a permissão <em>Excluir registros</em>.</li>
        <li><strong>Importar XML:</strong> traz para o sistema notas emitidas fora (por exemplo, no portal, para empresas sem certificado).</li>
        <li><strong>Baixar em lote</strong> as notas de um período (PDF e XML).</li>
      </ul>
      <p class="dica">Dúvida se a Sefin gerou a nota? Use <em>Consultar na Sefin</em> antes de excluir uma nota pendente.</p>`,
  },
  {
    id: 'agenda', titulo: 'Emissão automática', resumo: 'Preparar as notas e boletos do mês e confirmar de uma vez.',
    corpo: `
      <p>Para clientes com cobrança todo mês. O sistema <strong>prepara</strong> a emissão na data de cada cliente, usando o serviço padrão e o valor cadastrados; <strong>nada é emitido sem a sua confirmação</strong>.</p>
      <h3>Configurar</h3>
      <ol>
        <li>Em <strong>Clientes</strong>, cadastre o serviço e o valor na aba Serviços padrão.</li>
        <li>Em <strong>Emissão automática</strong>, clique em <em>Agendar</em> no cliente e escolha o dia do mês.</li>
      </ol>
      <h3>No dia a dia</h3>
      <p>Escolha o mês. Cada item aparece como <em>Pronta</em>, <em>Agendada</em> (ainda não chegou a data), <em>Emitida</em>, <em>Com erro</em> ou <em>Pulada</em>. Use <em>Emitir</em> em um item, <strong>Emitir prontas</strong> para todos de uma vez, <em>Pular</em> para ignorar o mês ou <em>Tentar de novo</em> nos que deram erro. Conforme o cliente, gera nota, nota + boleto ou só boleto.</p>`,
  },
  {
    id: 'cobrancas', titulo: 'Cobranças e boletos', resumo: 'Boletos, remessa, retorno e baixas.',
    corpo: `
      <p>A tela <strong>Cobranças</strong> lista os boletos da empresa com situação (pendente, pronto, enviado ao banco, registrado, pago, cancelado).</p>
      <h3>Cobrança pela Cora (sem remessa)</h3>
      <p>Em <strong>Empresas › Dados bancários</strong>, o bloco <em>Banco Cora</em> liga a API da Cora. Com ela, cada boleto (com Pix) é registrado na Cora assim que é criado, o PDF e a linha digitável vêm da Cora e o pagamento é baixado sozinho, a cada 10 minutos ou ao clicar em <em>Atualizar da Cora</em>. Não há arquivo de remessa nem de retorno.</p>
      <ol>
        <li>No app da Cora ou no Cora Web, abra <strong>Integrações via API</strong> e escolha <strong>Integração direta</strong>. Baixe o <em>Client ID</em>, o <em>certificado</em> e a <em>chave privada</em> (arquivos .pem). Teste e produção têm credenciais diferentes.</li>
        <li>No Kontor, escolha o ambiente, informe o Client ID, cole (ou escolha o arquivo do certificado e da chave e clique em <em>Salvar Cora</em>. O sistema confere se a chave pertence ao certificado. A chave fica criptografada neste computador e nunca é mostrada de novo.</li>
        <li>Clique em <em>Testar conexão</em>: se estiver tudo certo, aparece o saldo da conta.</li>
      </ol>
      <p>Regras da Cora: o boleto mínimo é de R$ 5,00; o cliente precisa ter CPF/CNPJ, endereço e CEP completos (se faltar, o motivo aparece na cobrança e, depois de corrigir o cadastro, <em>Atualizar da Cora</em> registra de novo). A Cora não altera um boleto: <em>Reemitir</em> cancela o antigo na Cora e cria outro. Boleto já pago na Cora não pode ser cancelado. O desconto por pagamento antecipado (antes do vencimento) não é enviado à Cora, que só aceita desconto até o vencimento. Os boletos antigos do convênio continuam com remessa e retorno.</p>
      <h3>Multa, juros e desconto por cliente</h3>
      <p>No cadastro do cliente, aba <strong>Descontos</strong>, você pode definir <em>multa</em> e <em>juros ao mês</em> próprios (em branco vale o padrão dos dados bancários da empresa; 0 isenta o cliente) e um <em>desconto por pagamento antecipado</em>: um percentual do boleto, válido até certo número de dias antes do vencimento (0 = até o vencimento). O desconto vai na remessa ao banco como desconto até a data e sai nas instruções impressas; depois do prazo vale o valor cheio. O boleto guarda as condições vigentes na data em que foi criado, então mudar o cadastro depois não altera boletos já emitidos.</p>
      <h3>Carteira Pix</h3>
      <p>Quem não tem convênio de boleto pode cobrar por Pix. No cadastro do cliente (<em>Faturamento</em>), escolha <strong>Carteira de cobrança: Pix copia e cola</strong>. Em Cobranças, as abas <em>Carteira boleto</em> e <em>Carteira Pix</em> separam os dois tipos.</p>
      <ol>
        <li>Gere a cobrança Pix no aplicativo do banco, com o valor da cobrança.</li>
        <li>Na cobrança do sistema, clique em <strong>Informar Pix</strong> e cole o código <em>copia e cola</em>. O sistema confere o código e recusa se o valor for diferente do da cobrança. <strong>Pix gerado pelo Kontor:</strong> cadastre a chave Pix da empresa (InfinitePay ou qualquer banco) em Empresas &gt; Dados bancários &gt; <em>Pix gerado pelo Kontor</em>. A partir daí, cada cobrança da carteira Pix já sai com o Pix copia e cola e o QR Code no valor certo, sem precisar abrir o aplicativo do banco; o dinheiro cai direto na conta da chave. O botão <em>Gerar o Pix das cobranças pendentes</em> resolve as que já estavam lançadas, e no <em>Informar Pix</em> há o botão <em>Gerar com a chave Pix da empresa</em>. A baixa do pagamento continua manual. Faça um Pix de teste de pequeno valor antes de enviar aos clientes.</li>
        <li>O <strong>Demonstrativo</strong> (PDF com logo, serviços, total e QR Code) fica pronto; o botão <strong>E-mail</strong> envia ao cliente com o copia e cola no texto.</li>
      </ol>
      <p>O demonstrativo também vai anexo nos e-mails de boleto e nota. O texto do rodapé é ajustado no botão <em>Demonstrativo</em>, na tela de Cobranças.</p>
      <h3>Carta de cobrança</h3>
      <p>Numa cobrança vencida, o menu <em>⋯</em> tem <em>Carta de cobrança (PDF)</em>: um aviso no papel timbrado com todas as cobranças vencidas e não pagas daquele cliente, os dias de atraso e a estimativa de multa e juros até hoje (pelas regras de cada cobrança), com o total atualizado e espaço para assinatura.</p>
      <h3>Fluxo com o banco (remessa e retorno)</h3>
      <ol>
        <li>Configure os <em>Dados bancários</em> da empresa (em Empresas).</li>
        <li>Os boletos são gerados na emissão, no faturamento automático ou como <strong>boleto avulso</strong>.</li>
        <li>Gere a <strong>remessa</strong> (arquivo CNAB) e envie no internet banking do banco, na área de cobrança.</li>
        <li>Depois do pagamento, baixe o <strong>arquivo de retorno</strong> no mesmo menu e importe aqui para dar baixa automática.</li>
      </ol>
      <h3>Outras ações</h3>
      <ul>
        <li><strong>Boleto:</strong> abre o PDF para imprimir ou enviar. <strong>WhatsApp</strong> abre a mensagem pronta.</li>
        <li><strong>Marcar pago:</strong> baixa manual. <strong>Reemitir:</strong> altera vencimento ou valor. <strong>Cancelar:</strong> se já foi ao banco, a baixa vai na próxima remessa.</li>
      </ul>`,
  },
  {
    id: 'compras', titulo: 'Compras (NF-e de entrada)', resumo: 'Buscar na SEFAZ as NF-e emitidas contra o CNPJ, importar o XML e lançar nas despesas.',
    corpo: `
      <p>O grupo <strong>Compras</strong> tem duas telas: <strong>Compras</strong> (lançar e consultar notas, num lugar só) e <strong>Buscar NF-e (SEFAZ)</strong> (notas emitidas contra o CNPJ). Na tela Compras, busque por fornecedor, número da nota, CNPJ ou chave, no período, e use <em>Importar XML da NF-e</em> ou <em>Lançar compra manual</em>.</p>
      <p>Toda nota que entra, pelo XML ou pela SEFAZ, abre <em>nota a nota</em> com o resumo (fornecedor, totais, itens) e o <strong>parcelamento da nota</strong>. Se o pagamento real for diferente, altere datas e valores, adicione ou remova parcelas, ou use <em>Refazer</em> em N parcelas a cada X dias; a soma precisa fechar com o total. Em <em>Condição de pagamento</em> escolha <strong>À vista</strong> (o parcelamento some e a <em>forma de pagamento</em> passa a ser obrigatória: PIX, débito, crédito ou dinheiro, que vai para as despesas geradas) ou <strong>Parcelado</strong> (abre o parcelamento).</p>
      <h3>Buscar NF-e (SEFAZ)</h3>
      <p>Com o certificado A1 da empresa cadastrado, a tela <strong>Buscar NF-e (SEFAZ)</strong> traz as NF-e emitidas contra o CNPJ direto do Ambiente Nacional, sem precisar pedir o XML ao fornecedor.</p>
      <ol>
        <li>Clique em <strong>Buscar agora</strong>. O sistema baixa as notas novas e registra a <em>Ciência da Operação</em> em cada uma: é ela que libera o XML completo na SEFAZ.</li>
        <li>O XML completo chega numa <strong>próxima busca</strong>. Deixe <em>Buscar automaticamente</em> marcado e o sistema consulta sozinho enquanto estiver aberto.</li>
        <li>Quando a nota aparecer como <strong>Pronta para importar</strong>, use <strong>Importar</strong> (ou marque várias e <em>Importar selecionadas</em>). Ela entra em Compras como se o XML tivesse sido enviado, com a opção de lançar as parcelas nas despesas.</li>
      </ol>
      <p><strong>Intervalo da SEFAZ:</strong> quando não há documentos novos, a SEFAZ só aceita nova consulta depois de 1 hora; o sistema respeita isso e mostra o horário liberado. Para uma nota específica, use <strong>Buscar pela chave</strong>.</p>
      <p>Notas <strong>canceladas pelo fornecedor</strong> aparecem riscadas e não podem ser importadas; se o cancelamento chegar depois da importação, um alerta em vermelho pede para conferir a compra. <strong>Ocultar</strong> esconde notas que não são compras da empresa (por exemplo, quando ela aparece só como transportadora). A Ciência da Operação não é a manifestação final: Confirmação, Desconhecimento ou Operação não Realizada continuam com o seu processo fiscal.</p>
      <p><strong>Conexão com a SEFAZ</strong> (administrador): o servidor da SEFAZ usa certificado ICP-Brasil, que o Windows nem sempre reconhece. O sistema já traz essa cadeia embutida (raízes v5, v10, v11 e v12 e as ACs SSL dos servidores da SEFAZ), então normalmente não há nada a fazer. Se um dia a busca avisar que não reconhece o certificado do servidor, use <em>Atualizar pelo site do ITI</em> ou envie o pacote <em>ACcompactado.zip</em> baixado pelo navegador.</p>
      <h3>Importar o XML da NF-e</h3>
      <ol>
        <li>Clique em <strong>Importar XML da NF-e</strong> e escolha um ou <em>vários</em> arquivos de uma vez (o XML que o fornecedor envia ou que se baixa no portal da NF-e).</li>
        <li>Deixe marcado <em>Lançar nas despesas</em> se quiser que cada parcela (duplicata) vire uma despesa na data de vencimento, na categoria escolhida; nota à vista vira uma despesa só.</li>
        <li>O resultado aparece arquivo por arquivo. O sistema lê fornecedor, itens (com NCM e CFOP), totais e parcelas.</li>
      </ol>
      <p>O sistema avisa e <strong>não importa</strong> quando a nota já foi importada, quando foi emitida pela própria empresa (é uma venda), ou quando o XML é de NFS-e ou de evento. Se o destinatário da nota for outro CNPJ, importa com um alerta para você conferir a empresa selecionada.</p>
      <h3>Compra manual</h3>
      <p><strong>Lançar compra manual</strong> registra uma compra sem XML (cupom, recibo). No fornecedor, digite para buscar ou use <strong>F2</strong> para consultar os fornecedores que já tiveram nota lançada; se for novo, informe o CNPJ e clique em <em>Buscar CNPJ</em> (ou saia do campo) para preencher o nome pela Receita. Informe o valor e a condição de pagamento: à vista (com a forma de pagamento) ou parcelado.</p>
      <h3>Detalhe, XML e exclusão</h3>
      <p>Clique na compra para ver itens, totais e parcelas e baixar o XML. <strong>Alterar parcelas</strong> refaz o parcelamento e acerta as despesas geradas (se uma parcela já estiver ligada ao extrato, desfaça o vínculo antes). Cada parcela vira uma despesa; quando o pagamento aparecer no extrato, ligue-o em <em>Extrato e conciliação</em>. <strong>Excluir compra</strong> (permissão <em>Excluir registros</em>) apaga também as despesas que ela gerou. O relatório <em>Compras (NF-e de entrada)</em> está em Relatórios. O acesso a Compras é liberado por usuário em Configurações &gt; Usuários e acessos.</p>`,
  },
  {
    id: 'tributacao', titulo: 'Tributação', resumo: 'Impostos, tributações e o vínculo com serviços e compras.',
    corpo: `
      <p>Em <strong>Tributação</strong> você cadastra os impostos uma vez, monta cada <em>tributação</em> e só então vincula serviços e compras a ela.</p>
      <h3>1. Impostos</h3>
      <p>Catálogo pronto: ISS, ICMS, IPI, PIS, COFINS, CSLL, IRRF, INSS, IBS (estadual e municipal) e CBS. Dá para renomear e desativar o que a empresa não usa.</p>
      <h3>2. Tributações</h3>
      <p>Uma tributação é um conjunto de linhas: imposto, alíquota, redução de base, se é <strong>retido</strong>, CST e cClassTrib (IBS/CBS) e a <strong>vigência</strong> (de/até). Como as alíquotas do IBS/CBS mudam ao longo da transição, use uma linha por período; vale a que está em vigor na data do documento.</p>
      <h3>3. Onde a tributação se aplica</h3>
      <p>Na própria tributação você diz se ela vale para <em>serviços prestados</em> (saída) ou <em>compras</em> (entrada), a natureza (serviço, revenda, insumo, uso e consumo, ativo imobilizado, devolução), o código padrão, se <em>gera crédito</em> e o destino financeiro. Marque uma como <strong>padrão</strong> para ela valer quando o serviço ou a compra não indicar nenhuma.</p>
      <p>O botão <strong>Criar a partir dos serviços</strong> converte as retenções já cadastradas nos serviços em tributações, e vincula cada serviço.</p>
      <h3>4. Vínculos</h3>
      <ul>
        <li><strong>Serviço (saída):</strong> no cadastro do serviço, campo <em>Tributação</em>. As retenções e o ISS retido passam a vir dela, tanto na tela de emissão quanto no XML da DPS.</li>
        <li><strong>Compra (entrada):</strong> ao importar o XML ou lançar manualmente, escolha a tributação (ou deixe a padrão).</li>
      </ul>
      <p class="dica">O acesso é liberado por usuário (permissão <em>Tributação</em>).</p>`,
  },
  {
    id: 'despesas', titulo: 'Despesas e balanço', resumo: 'Lançar despesas e acompanhar receitas × despesas.',
    corpo: `
      <p>Em <strong>Despesas e balanço</strong> lance as despesas da empresa por categoria e acompanhe o resultado do mês: o que foi <em>recebido</em> (boletos pagos) contra o que foi gasto. Marcar as cobranças como pagas e lançar as despesas mantém o balanço confiável. O <strong>Painel do mês</strong> resume faturado, recebido, a receber, em atraso e quem ainda falta emitir. Em cada despesa informe <strong>Pago com</strong> (PIX, débito, crédito ou dinheiro): é o que permitirá vincular o gasto ao extrato para justificá-lo. As despesas vindas do extrato aparecem com a marca “extrato” e são alteradas lá, não aqui.</p>`,
  },
  {
    id: 'extrato', titulo: 'Extrato e conciliação', resumo: 'Importar o extrato em PDF, classificar e ligar aos boletos.',
    corpo: `
      <p>O sistema lê o extrato da conta corrente em PDF nos formatos de banco já homologados; outros bancos entram aos poucos. Se o PDF não for reconhecido, o sistema avisa.</p>
      <p>Se a empresa usa a <strong>Cora</strong>, o botão <em>Sincronizar com a Cora</em> traz os lançamentos e o saldo direto da conta, sem PDF, com a mesma classificação e conciliação.</p>
      <ol>
        <li>Em <strong>Extrato e conciliação</strong>, clique em <em>Importar extrato (PDF)</em>. O sistema confere o total lido com o saldo do próprio extrato.</li>
        <li><strong>Classifique</strong> entradas e saídas por categoria. Regras aprendem com o que você classifica e valem para lançamentos parecidos.</li>
        <li>Nas entradas, use <strong>Ligar a boleto</strong> para conciliar o recebimento com o boleto (aparecem os boletos de valor compatível, mesmo com vencimento diferente da data do crédito).</li>
        <li>O balanço do mês só fecha quando não há lançamentos sem classificação.</li>
      </ol>
      <p><strong>Ligar a despesa:</strong> numa saída, clique em <em>Ligar a despesa</em> para ligá-la a uma despesa já lançada (a parcela de uma compra, por exemplo) com o mesmo valor e data próxima. A despesa passa a ser a própria saída do extrato, sem aparecer duas vezes; <em>desfazer</em> desliga. Fluxo recomendado: lance a NF-e em <em>Compras</em> (gera despesa e parcelas) e, quando o pagamento cair no extrato, ligue.</p>
      <p><strong>Reflexo em Despesas e balanço:</strong> toda <em>saída classificada</em> vira automaticamente uma despesa (marcada como “extrato”, com o PIX/débito deduzido da descrição). Reclassificar no extrato atualiza a despesa; excluir a importação remove as despesas dela. Ficam de fora as categorias <em>Cartão de crédito</em> (os gastos entram pela própria fatura) e <em>Transferências</em>. Entradas classificadas como <em>Outras receitas</em> (sem boleto) entram nas receitas do balanço.</p>
      <p class="dica">Importar o mesmo extrato duas vezes não duplica os lançamentos. Uma importação errada pode ser excluída na lista de importações.</p>`,
  },
  {
    id: 'cartao', titulo: 'Fatura do cartão de crédito', resumo: 'Importar a fatura em PDF e levar os gastos para as despesas.',
    corpo: `
      <p>Em <strong>Financeiro &gt; Fatura do cartão</strong> importe o PDF da fatura do cartão (formatos de emissor já homologados). O sistema lê cada compra (data, estabelecimento, cidade, parcela e final do cartão) e confere a soma com os totais impressos na própria fatura.</p>
      <ol>
        <li>Clique em <em>Importar fatura (PDF)</em>. Importar o mesmo arquivo duas vezes é recusado.</li>
        <li>Classifique cada gasto (a categoria é lembrada para compras parecidas, inclusive no extrato bancário). Anuidade e encargos já entram como <em>Tarifas e juros</em>.</li>
        <li>Os gastos classificados aparecem em <strong>Despesas e balanço</strong> como “Crédito”, no <em>mês do vencimento da fatura</em> (quando o dinheiro sai de fato), com a data da compra na descrição.</li>
      </ol>
      <p>O pagamento da fatura no extrato (categoria “Cartão de crédito”) não é contado outra vez. O pagamento da fatura anterior e créditos de estorno aparecem na lista, mas não viram despesa; um desconto de anuidade cancela a própria anuidade. Excluir a fatura remove as despesas geradas.</p>`,
  },
  {
    id: 'relatorios', titulo: 'Relatórios', resumo: 'Os relatórios disponíveis e qual data cada um usa.',
    corpo: `
      <p>A nota é emitida em um dia, o boleto vence em outro e é pago em outro. Por isso cada relatório informa <strong>qual data filtra o período</strong> e mostra as demais nas colunas.</p>
      <p>Os relatórios ficam em <strong>grupos</strong>, na lista à esquerda da tela:</p>
      <ul>
        <li><strong>Faturamento:</strong> Receitas emitidas (por data de emissão) e Faturamento por mês (notas, canceladas e recebido) e Faturamento por cidade/UF do cliente.</li>
        <li><strong>Contas a receber:</strong> por vencimento, em aberto por emissão, recebimentos (data do pagamento), saldo vencido por cliente (faixas de atraso), posição por cliente e prazo de recebimento por cliente (prazo e atraso médios, % pago em dia) e contas a receber por carteira (boleto × Pix, com subtotal de cada uma).</li>
        <li><strong>Despesas e pagamentos:</strong> despesas lançadas (com forma de pagamento e origem), por categoria, por forma de pagamento (PIX, débito, crédito, dinheiro), parcelas do cartão a vencer e compras (NF-e de entrada).</li>
        <li><strong>Fiscal e retenções:</strong> notas emitidas e tributos, livro de serviços prestados (ISS a recolher e ISS retido pelo tomador) e retenções por cliente (PIS, COFINS, CSLL, IRRF, INSS e ISS).</li>
        <li><strong>Resultado e caixa:</strong> resultado mensal (o balanço mês a mês), fluxo de caixa por categoria e pendências do extrato (sem classificação ou crédito sem boleto ligado).</li>
        <li><strong>Clientes:</strong> curva ABC (classes A, B e C pelo faturamento) e clientes sem faturamento no período e clientes com cadastro incompleto (o que falta e o que isso atrapalha: nota, boleto ou e-mail).</li>
      </ul>
      <p>Clique no relatório na lista, escolha o período, o cliente e a situação (quando houver) e clique em <em>Gerar</em>. Exporte para <strong>Excel (CSV)</strong> ou <strong>PDF</strong>; o PDF sai no papel timbrado da empresa (logo, CNPJ, endereço e contato no cabeçalho e o rodapé do demonstrativo em todas as páginas).</p>`,
  },
  {
    id: 'contabilidade', titulo: 'Exportar para a contabilidade', resumo: 'Pacote com extrato em OFX, PDF e XML das notas.',
    corpo: `
      <p>Em <strong>Configurações &gt; Contabilidade</strong> (administrador) escolha a empresa e o mês. O sistema gera um pacote ZIP com o extrato convertido em <strong>OFX</strong>, o extrato em <strong>PDF</strong> e os <strong>XML</strong> de todas as notas emitidas no período, pronto para enviar ao contador.</p>
      <p>Marque o que vai no pacote: notas emitidas (XML e PDF), <strong>notas de entrada lançadas em Compras</strong>, <strong>notas recebidas da SEFAZ ainda não lançadas</strong> e o extrato em OFX. As entradas vão em <code>entradas/xml</code> com uma planilha (fornecedor, valor, chave, parcelas); as não lançadas e as canceladas pelo fornecedor vêm marcadas.</p>
      <h3>Fechamento mensal automático</h3>
      <p>Na mesma tela, informe o <strong>e-mail da contabilidade</strong> (até 5), ligue <em>Enviar automaticamente todo mês</em> e escolha o <strong>dia</strong>. Nesse dia o sistema envia sozinho, em anexo, o pacote completo do <strong>mês anterior</strong>. Usa o e-mail do escritório configurado em <em>E-mail</em>. Se o sistema estiver fechado no dia, envia na primeira vez que for aberto depois; se falhar, tenta de novo em 6 horas e mostra o motivo. <em>Enviar agora</em> dispara qualquer mês na hora. Pacotes acima de 20 MB não vão por e-mail.</p>`,
  },
  {
    id: 'configuracoes', titulo: 'Configurações', resumo: 'Usuários, e-mail, aparência, backup, licença e atualizações.',
    corpo: `
      <ul>
        <li><strong>Minha conta:</strong> altere sua senha.</li>
        <li><strong>Usuários e acessos</strong> (administrador): crie usuários e libere por usuário as funcionalidades (emissão, notas, cobranças, relatórios etc.) e as empresas que cada um enxerga. A permissão <strong>Excluir registros</strong> é separada das demais: sem ela o usuário não vê nem consegue usar nenhuma exclusão (nota não autorizada, serviço, despesa, importação de extrato), mesmo tendo acesso à tela. O administrador sempre pode. Ao criar um usuário sem senha ou ao <strong>redefinir a senha</strong>, o sistema gera uma <strong>senha provisória</strong> aleatória, mostrada uma única vez para você entregar à pessoa; no primeiro acesso ela cria a própria senha.</li>
        <li><strong>Esqueci minha senha</strong> (tela de login): o sistema envia um código de 6 dígitos ao e-mail do usuário, e com ele a pessoa cria a senha nova na mesma hora.</li>
        <li><strong>Usuário KONTOR</strong> (suporte): não tem senha. O suporte do Kontor só entra com um código gerado para este computador, que expira em poucas horas.</li>
        <li><strong>E-mail:</strong> servidor SMTP usado para enviar notas e boletos aos clientes e para a recuperação de senha.</li>
        <li><strong>Assinatura:</strong> na mesma aba, uma imagem (PNG ou JPG) que vai no fim de todos os e-mails aos clientes.</li>
        <li><strong>Modelos de e-mail:</strong> o texto de cada e-mail (nota, cancelamento, boleto, Pix e fechamento para a contabilidade). Clique nos campos automáticos (como <code>{{cliente}}</code> e <code>{{valor}}</code>) para inserir, veja a prévia ao vivo, envie um teste para você e, se quiser, restaure o texto sugerido. Se um campo estiver vazio em um envio, a linha dele não vai no e-mail.</li>
        <li><strong>Aparência:</strong> escolha entre <em>Preto e laranja</em>, <em>Branco e laranja</em>, <em>Azul e dourado</em>, <em>Azul e roxo</em>, <em>Verde petróleo e esmeralda</em>, <em>Grafite e azul elétrico</em>, <em>Marrom e champagne</em>, <em>Roxo e rosa</em>. Vale para o computador.</li>
        <li><strong>Backup:</strong> o sistema faz cópia automática diária; também dá para baixar um backup quando quiser. Guarde uma cópia fora do computador.</li>
        <li><strong>Licença:</strong> mostra a situação e o <strong>plano</strong> e permite informar um novo código. O período de teste dura <strong>7 dias</strong> e permite <strong>1 empresa e 2 clientes</strong>. Os planos pagos são <strong>Bronze</strong> (R$ 200/mês, 1 empresa), <strong>Prata</strong> (R$ 350/mês, até 5 empresas), <strong>Ouro</strong> (R$ 600/mês, até 15 empresas) e <strong>Diamante</strong> (ilimitado, sob encomenda). O botão <strong>Alterar plano</strong> mostra os planos e abre o WhatsApp do suporte já com o código do computador; depois do pagamento você recebe o novo código e o cola ali. Ao atingir o limite do plano, o cadastro de nova empresa ou de novo cliente pede a troca de plano. Nos <strong>15 dias</strong> antes do vencimento (da licença ou do período de teste) o menu mostra "Licença vence em N dia(s)" em destaque e o sistema abre um aviso uma vez por dia, com o código do computador para pedir a renovação. Vencida a licença, a emissão e os módulos adicionais são bloqueados.</li>
        <li><strong>Módulos adicionais:</strong> módulos vendidos à parte vêm instalados em todas as versões e ficam liberados durante o período de teste; com a licença paga, só funcionam se o código de ativação os trouxer. Sem o módulo, o item continua no menu com a marca <em>contratar</em> e abre a apresentação com o botão <strong>Quero contratar</strong>, que chama o suporte no WhatsApp com o código do computador. Depois de contratado, basta colar o novo código em Licença: o módulo aparece na hora, sem reinstalar.</li>
        <li><strong>Atualizações:</strong> quando sai uma versão nova, aparece um aviso no topo com três opções: <em>Atualizar agora</em> (baixa, faz a cópia de segurança e instala), <em>Baixar e instalar ao fechar</em> (baixa agora e instala sozinho quando você fechar o programa) e <em>Só baixar</em> (deixa pronta; depois é só clicar em <em>Instalar agora</em>). Os dados são preservados.</li>
      </ul>`,
  },
  {
    id: 'atalhos', titulo: 'Atalhos e dicas', resumo: 'Atalhos de teclado e boas práticas.',
    corpo: `
      <p><strong>Menu:</strong> as telas ficam em grupos (Faturamento, Compras, Financeiro, Cadastros). Clique no nome do grupo para abrir ou recolher; o grupo da tela atual abre sozinho.</p>
      <ul>
        <li>Em Emitir nota, digite no campo do cliente para buscar na hora; <kbd>F2</kbd> abre a consulta completa (setas, Enter para escolher, Esc para fechar).</li>
        <li>Confira sempre a <strong>empresa selecionada</strong> no alto do menu antes de emitir.</li>
        <li>Teste primeiro em <em>Produção restrita</em>.</li>
        <li>Mantenha backup fora do computador e renove o certificado A1 antes do vencimento.</li>
      </ul>`,
  },
  {
    id: 'problemas', titulo: 'Problemas comuns', resumo: 'O que fazer nos erros mais frequentes.',
    corpo: `
      <dl class="faq">
        <dt>"Cadastre o certificado A1 da empresa antes de emitir"</dt><dd>Envie o certificado em Empresas &gt; Certificado, ou mude a empresa para o modo Portal se ela emite sem certificado.</dd>
        <dt>Nota rejeitada</dt><dd>Leia o código e o motivo na tela da nota, corrija os dados em <em>Corrigir e reenviar</em>. Se não for possível corrigir, exclua a nota rejeitada e emita outra.</dd>
        <dt>A Sefin não respondeu</dt><dd>Use <em>Consultar na Sefin</em> na nota. Se ela existir, é recuperada; senão, reenvie.</dd>
        <dt>Não consigo gerar boleto</dt><dd>Falta preencher os Dados bancários da empresa (Empresas &gt; Dados bancários).</dd>
        <dt>Não encontro uma opção no menu</dt><dd>Seu usuário pode não ter a permissão; peça ao administrador em Configurações &gt; Usuários e acessos.</dd>
        <dt>Extrato não confere</dt><dd>O sistema compara o total lido com o do PDF e avisa a diferença; confirme se o PDF é de um banco homologado e do período completo.</dd>
      </dl>`,
  },
];
