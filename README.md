# Kontor Gestão Transportadora

Operação, frota e financeiro de transportadoras, para Windows. Mesma arquitetura do Kontor Gestão
Empresas e do Kontor Gestão Contabilidade: Electron, servidor local Fastify (TypeScript), banco SQLite no
computador do cliente e interface em JavaScript puro.

Escopo e protótipo: documento "Kontor Gestão Transportadora — Escopo" no Claude.

## Estado

Base copiada do Kontor Gestão Empresas 3.37.1 e renomeada (identidade, pasta de dados, porta, instalador).
Os módulos fiscais de NFS-e e demais telas do Empresas ainda estão aqui e serão removidos aos poucos,
conforme entram viagem, frota e financeiro de frete.

## Desenvolvimento

    npm ci
    npm run dev        # servidor em http://localhost:3000
    npm test
    npm run desktop    # abre no Electron

## Pendências antes de distribuir

- Gerar o par de chaves de licença próprio em `ferramentas/gerador-de-licencas.html` e colocar a chave pública
  em `src/licenca-chave.ts` (vazia = modo livre). Não reutilizar a chave do Empresas.
  O teste "teste de 7 dias" falha de propósito enquanto a chave estiver vazia, e assim impede gerar instalador sem ela.
- Criar o repositório público de releases e o secret `RELEASES_TOKEN`.
