# XSD da DPS — NT 009, release 1 (produção restrita)

Esquemas oficiais da **produção restrita** da NFS-e Nacional, sem alterações.

- Pacote oficial: `esquemas_prod_restrita_20261020.zip`, publicado em 20/10/2026 em
  https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita
- SHA-256 do pacote (informado na cópia pública de onde os arquivos foram tirados):
  `25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267`
- Arquivos usados: `DPS_v1.01.xsd`, `tiposComplexos_v1.01.xsd`, `tiposSimples_v1.01.xsd`, `xmldsig-core-schema.xsd`.
- **Conferir antes de ir para produção:** baixar o pacote no portal, confirmar o SHA-256 acima e comparar os arquivos
  (`sha256sum schemas/nt009-r1/*.xsd`):
  - DPS_v1.01.xsd `fe45e5250a48e519aba89fc6a472863b8e602ed957778fb64692804933a00d0c`
  - tiposComplexos_v1.01.xsd `4f66f7c15bd3b05b3a16cbe5fa671b90c10e4c9c74276038730be1c8c794b721`
  - tiposSimples_v1.01.xsd `562e326724f85cd7c41176d35e67c542376784d4c950ec1719704d480a8af226`
  - xmldsig-core-schema.xsd `8c9792a056aedcadfc95bf16f2d7448a35da40df71533e20aea37d0329980c48`

O que muda em relação a `schemas/1.01` (leiaute NT 004 + NT 007, ainda vigente em produção até 30/11/2026):

1. `finNFSe` sai do grupo `IBSCBS` e vai para `infDPS`, logo após `tpEmit` (item 2.16 da NT 009).
2. `CST` e `cClassTrib` ficam direto em `IBSCBS/valores/trib`; `gIBSCBS` passa a ser só o detalhamento opcional.
3. `vDedRed` e `gReeRepRes` foram unificados em `valores/vAjusteBC` (item 2.3), com tipos 101–105 e 199.
4. Em `cServ`, `cNBS` vem antes de `xDescServ`.
5. Padrões de CNPJ, chaves e Id da DPS aceitam o CNPJ alfanumérico; série aceita até 89999.

Produção: 01/12/2026, conforme comunicado do CGNFS-e.
