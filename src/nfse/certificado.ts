import forge from 'node-forge';

export interface CertificadoA1 {
  chavePem: string;
  /** Certificado do titular (usado na assinatura e no mTLS). */
  certPem: string;
  /** Titular + cadeia intermediária, para o handshake TLS. */
  cadeiaPem: string;
  /** Base64 DER do certificado do titular, para o KeyInfo da assinatura. */
  certBase64: string;
  titular: string;
  documento: string | null;
  validoDe: Date;
  validoAte: Date;
}

const OID_CNPJ_ICP = '2.16.76.1.3.3';

/**
 * Lê um certificado A1 (.pfx/.p12). Usa node-forge para aceitar também os arquivos
 * com criptografia legada (RC2/3DES) que o OpenSSL 3 recusa por padrão.
 */
export function lerPfx(pfx: Buffer, senha: string): CertificadoA1 {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, senha);
  } catch {
    throw new Error('Não foi possível abrir o certificado. Confira o arquivo .pfx e a senha.');
  }

  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const chave = chaves.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!chave) throw new Error('O arquivo não contém chave privada.');

  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);

  // Certificado do titular = aquele cuja chave pública corresponde à chave privada.
  const titular = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n && pub.n.equals(chave.n);
  });
  if (!titular) throw new Error('Certificado do titular não encontrado no arquivo.');
  const intermediarios = certs.filter((c) => c !== titular);

  const cn = (titular.subject.getField('CN')?.value as string) ?? '';
  const certPem = forge.pki.certificateToPem(titular);

  return {
    chavePem: forge.pki.privateKeyToPem(chave),
    certPem,
    cadeiaPem: [certPem, ...intermediarios.map((c) => forge.pki.certificateToPem(c))].join('\n'),
    certBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(titular)).getBytes()),
    titular: cn,
    documento: extrairDocumento(titular, cn),
    validoDe: titular.validity.notBefore,
    validoAte: titular.validity.notAfter,
  };
}

/** e-CNPJ ICP-Brasil: o CNPJ vem no CN ("RAZAO SOCIAL:12345678000199") ou no SAN (OID 2.16.76.1.3.3). */
function extrairDocumento(cert: forge.pki.Certificate, cn: string): string | null {
  const doCn = cn.split(':').pop()?.trim();
  if (doCn && /^[0-9A-Z]{14}$|^\d{11}$/.test(doCn)) return doCn;
  try {
    const ext = cert.getExtension('subjectAltName') as { altNames?: { type: number; value: string }[] } | undefined;
    const der = forge.asn1.fromDer((ext as unknown as { value: string })?.value ?? '');
    const busca = (n: forge.asn1.Asn1): string | null => {
      if (Array.isArray(n.value)) {
        for (let i = 0; i < n.value.length; i++) {
          const filho = n.value[i] as forge.asn1.Asn1;
          if (filho.type === forge.asn1.Type.OID && forge.asn1.derToOid(filho.value as string) === OID_CNPJ_ICP) {
            const txt = JSON.stringify(n.value[i + 1]).match(/\d{14}/);
            if (txt) return txt[0];
          }
          const r = busca(filho);
          if (r) return r;
        }
      }
      return null;
    };
    return busca(der);
  } catch {
    return null;
  }
}
