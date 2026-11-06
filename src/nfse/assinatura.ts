import { SignedXml } from 'xml-crypto';
import type { CertificadoA1 } from './certificado.js';
import { DECLARACAO_XML } from './xml.js';

/**
 * Assina o elemento indicado (infDPS ou infPedReg) com XMLDSig enveloped,
 * nos parâmetros do Manual de Integração do Sistema Nacional NFS-e:
 *  - C14N inclusiva (REC-xml-c14n-20010315)
 *  - RSA-SHA1 e digest SHA1
 *  - KeyInfo apenas com o certificado do titular
 *  - Signature sem prefixo, como último filho do elemento raiz (irmã do elemento assinado)
 */
export function assinarXml(xml: string, elemento: 'infDPS' | 'infPedReg', cert: CertificadoA1): string {
  const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const sig = new SignedXml({
    privateKey: cert.chavePem,
    publicCert: cert.certPem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: C14N,
  });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data>`;
  sig.addReference({
    xpath: `//*[local-name(.)='${elemento}']`,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${elemento}']`, action: 'after' },
  });
  // A declaração vai depois da assinatura: ela não faz parte do infDPS/infPedReg assinado.
  return DECLARACAO_XML + sig.getSignedXml();
}
