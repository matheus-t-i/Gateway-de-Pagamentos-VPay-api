/**
 * Claims de audience/issuer do JWT.
 *
 * Painel e API pública compartilham `JWT_SECRET`, mas NÃO compartilham
 * audience — sem isso um Bearer de credencial_api poderia ser aceito no
 * painel (ou o inverso) se o claim `tipo` falhasse.
 */
export const JWT_ISSUER = () => process.env.JWT_ISSUER?.trim() || 'vpay';
export const JWT_AUDIENCE_PAINEL = () =>
  process.env.JWT_AUDIENCE_PAINEL?.trim() || 'vpay-painel';
export const JWT_AUDIENCE_API = () =>
  process.env.JWT_AUDIENCE_API?.trim() || 'vpay-api';
