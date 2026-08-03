/**
 * Validação de ambiente no BOOT (fail-fast).
 *
 * Sem isto, um deploy sobe com JWT_SECRET/ENCRYPTION_KEY de exemplo e só falha
 * tarde — ou pior, funciona com segredo público e permite forjar token de
 * administrador. Em produção o processo recusa iniciar.
 */

/** Valores de exemplo que NUNCA podem ir para produção. */
const SEGREDOS_PROIBIDOS = new Set([
  'dev-jwt-secret-gateway-vpay-change-in-prod',
  'change-me-in-production-use-long-random-string',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'mock-webhook-x-key-dev',
  'Admin@123456',
]);

export function validarAmbiente(env: Record<string, string | undefined>) {
  const producao = env.NODE_ENV === 'production';
  const erros: string[] = [];

  const obrigatorias = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'];
  for (const nome of obrigatorias) {
    if (!env[nome]) erros.push(`${nome} é obrigatória.`);
  }

  if (env.ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) {
    erros.push('ENCRYPTION_KEY deve ter 64 caracteres hexadecimais (32 bytes).');
  }

  if (producao) {
    // Segredos de exemplo derrubam o boot.
    for (const nome of ['JWT_SECRET', 'ENCRYPTION_KEY', 'MOCK_PROVIDER_WEBHOOK_KEY', 'ADMIN_PASSWORD']) {
      const valor = env[nome];
      if (valor && SEGREDOS_PROIBIDOS.has(valor)) {
        erros.push(`${nome} está com o valor de exemplo — gere um segredo próprio.`);
      }
    }
    if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
      erros.push('JWT_SECRET deve ter ao menos 32 caracteres em produção.');
    }
    if (!env.WEB_URL) {
      erros.push('WEB_URL é obrigatória em produção (origem do CORS com credenciais).');
    }
    // Atrás do proxy do Render/Vercel, sem isto req.ip vira o IP do balanceador
    // e as allowlists de IP (webhook do provedor e credencial de API) perdem o efeito.
    if (env.TRUST_PROXY !== '1') {
      erros.push(
        'TRUST_PROXY=1 é obrigatório em produção atrás de proxy — sem ele as allowlists de IP não funcionam.',
      );
    }
    if (!env.STORAGE_DRIVER || env.STORAGE_DRIVER === 'local') {
      erros.push(
        'STORAGE_DRIVER=local em produção: documentos de KYC seriam perdidos em disco efêmero. Configure o bucket.',
      );
    }
  }

  if (erros.length > 0) {
    throw new Error(
      'Configuração inválida para iniciar:\n  - ' + erros.join('\n  - '),
    );
  }
}
