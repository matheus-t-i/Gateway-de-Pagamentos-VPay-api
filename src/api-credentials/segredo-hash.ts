import { createHmac, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';

/**
 * Verificação do segredo de credencial de API.
 *
 * ⚠️ PREMISSA QUE SUSTENTA TUDO AQUI: o segredo é **gerado pelo servidor** com
 * `randomBytes(32)` — 256 bits de CSPRNG. Não existe dicionário nem força bruta
 * viável contra isso, então o fator de trabalho de um KDF lento não compra
 * NADA: só paga.
 *
 * Se algum dia a VPay permitir "traga seu próprio segredo", esta premissa cai —
 * segredo escolhido por humano tem entropia baixa e VOLTA a exigir argon2.
 *
 * Por que isso importava: o guard rodava `argon2.verify` (m=64MB, t=3, p=4) em
 * TODA requisição da API pública. Medido: 27,6 ms de relógio e ~87 ms de CPU
 * por chamada, com 64 MB alocados, travando o processo em ~73 req/s por causa
 * do threadpool do libuv. E como a chave pública NÃO é segredo, qualquer um
 * podia forçar esse custo mandando secret errado. Um HMAC resolve os dois
 * problemas: 0,002 ms e nada para amplificar.
 *
 * O `pepper` (env, fora do banco) preserva a única propriedade que importava do
 * hash: quem faz dump da tabela sem o env não consegue confirmar um palpite.
 */

const PREFIXO = 'hmac1$';

/**
 * Lido a cada uso e não em cache de módulo: assim um processo que suba sem a
 * variável falha na primeira verificação, alto e claro, em vez de aceitar ou
 * recusar tudo silenciosamente.
 */
function pepper(): Buffer {
  const p = process.env.API_SECRET_PEPPER;
  if (!p || p.trim().length < 32) {
    throw new Error(
      'API_SECRET_PEPPER ausente ou muito curto (mínimo 32 caracteres hex). ' +
        'Sem ele nenhuma credencial de API pode ser verificada.',
    );
  }
  return Buffer.from(p.trim(), 'utf8');
}

export function hashSegredo(segredo: string): string {
  return PREFIXO + createHmac('sha256', pepper()).update(segredo).digest('hex');
}

export type ResultadoVerificacao = {
  ok: boolean;
  /** Hash antigo (argon2) que confere — reescrever no formato novo. */
  precisaMigrar: boolean;
};

/**
 * Aceita os DOIS formatos: o `$argon2id$…` legado e o `hmac1$…` novo. O prefixo
 * é o próprio discriminador, então a migração acontece sem coluna nova e sem
 * downtime.
 */
export async function verificarSegredo(
  hashArmazenado: string,
  segredo: string,
): Promise<ResultadoVerificacao> {
  if (hashArmazenado.startsWith('$argon2')) {
    const ok = await argon2.verify(hashArmazenado, segredo);
    // Só migra quando o segredo confere: é o único momento em que temos o valor
    // em claro para recalcular o hash novo.
    return { ok, precisaMigrar: ok };
  }

  if (!hashArmazenado.startsWith(PREFIXO)) {
    return { ok: false, precisaMigrar: false };
  }

  const esperado = Buffer.from(hashArmazenado.slice(PREFIXO.length), 'hex');
  const calculado = Buffer.from(hashSegredo(segredo).slice(PREFIXO.length), 'hex');

  /**
   * `timingSafeEqual`, NUNCA `===`. O `argon2.verify` fazia comparação em tempo
   * constante de graça; trocar por igualdade de string reintroduziria um timing
   * attack de verdade — o atacante descobriria o segredo byte a byte.
   * `timingSafeEqual` exige buffers do mesmo tamanho, daí a checagem antes.
   */
  if (esperado.length !== calculado.length) return { ok: false, precisaMigrar: false };
  return { ok: timingSafeEqual(esperado, calculado), precisaMigrar: false };
}
