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
  'troque_por_32_bytes_hex_aleatorios',
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
    // Owner do banco fica SÓ no `migrate deploy` (directUrl); o runtime usa o
    // usuário de aplicação. Sem a variável, a migração do preDeploy não roda —
    // melhor recusar o boot com o motivo do que falhar o deploy sem contexto.
    if (!env.DIRECT_DATABASE_URL) {
      erros.push(
        'DIRECT_DATABASE_URL é obrigatória em produção (owner do banco, usada só pelas migrations — o runtime conecta com o usuário de aplicação em DATABASE_URL).',
      );
    }
    // Segredos de exemplo derrubam o boot.
    for (const nome of [
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'MOCK_PROVIDER_WEBHOOK_KEY',
      'ADMIN_PASSWORD',
      'API_SECRET_PEPPER',
      'VALORION_WEBHOOK_TOKEN',
    ]) {
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
    if (env.STORAGE_DRIVER === 's3') {
      if (!env.S3_BUCKET) erros.push('S3_BUCKET é obrigatória com STORAGE_DRIVER=s3.');
      if (!env.S3_REGION && !env.AWS_REGION) {
        erros.push('S3_REGION (ou AWS_REGION) é obrigatória com STORAGE_DRIVER=s3.');
      }
      /**
       * Credencial ausente subia a app inteira e só estourava no PRIMEIRO
       * upload de documento — 500 opaco, em produção, com o admin sem saber se
       * a culpa era do arquivo. O boot conferia bucket e região e parava aí.
       *
       * Os dois nomes valem: `.env.example` documenta `S3_*` e o `render.yaml`
       * pede `AWS_*`. Em plataforma com role de instância (ECS/EC2), onde a
       * cadeia padrão do SDK resolve sozinha, use `S3_CREDENCIAL_IMPLICITA=1`
       * para dispensar esta checagem — no Render não existe role, então o
       * padrão é exigir.
       */
      const temCredencial =
        (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) ||
        (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
      if (!temCredencial && env.S3_CREDENCIAL_IMPLICITA !== '1') {
        erros.push(
          'Credencial de S3 ausente: defina S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY ' +
            '(ou AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). Sem ela o boot passa e o ' +
            'upload de documento falha com 500. Em infra com role de instância, ' +
            'defina S3_CREDENCIAL_IMPLICITA=1.',
        );
      }
    }
    if (!env.API_SECRET_PEPPER || env.API_SECRET_PEPPER.trim().length < 32) {
      erros.push(
        'API_SECRET_PEPPER é obrigatória em produção (≥32 caracteres). Sem ela as credenciais de API não têm pepper.',
      );
    }
    if (!env.VALORION_WEBHOOK_TOKEN || env.VALORION_WEBHOOK_TOKEN.trim().length < 16) {
      erros.push(
        'VALORION_WEBHOOK_TOKEN é obrigatória em produção (≥16 caracteres). Sem ela a Camada 2 do webhook fica desligada.',
      );
    }
    if (!env.API_PUBLIC_URL) {
      erros.push(
        'API_PUBLIC_URL é obrigatória em produção (monta o postbackUrl enviado à liquidante).',
      );
    }
    if (!env.TURNSTILE_SECRET_KEY || env.TURNSTILE_SECRET_KEY.trim().length < 16) {
      erros.push(
        'TURNSTILE_SECRET_KEY é obrigatória em produção (Cloudflare Turnstile no login).',
      );
    }
  }

  if (erros.length > 0) {
    throw new Error(
      'Configuração inválida para iniciar:\n  - ' + erros.join('\n  - '),
    );
  }
}
