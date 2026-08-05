import { SetMetadata } from '@nestjs/common';
import type { CodigoPermissao } from '../shared';

export const CHAVE_PERMISSOES = 'vpay:permissoes';

/**
 * Declara a permissão exigida por uma rota (ou por todas as rotas do
 * controller, quando aplicado na classe). A checagem é feita dentro do
 * `JwtAuthGuard` — de propósito: se fosse um guard separado, esquecer de
 * registrá-lo faria a rota passar a aceitar qualquer usuário autenticado,
 * silenciosamente. Como está, basta o `@UseGuards(JwtAuthGuard)` que os
 * controllers já têm.
 *
 * Vários códigos = exige TODOS. A declaração no método sobrepõe a da classe.
 */
export const RequerPermissao = (...codigos: CodigoPermissao[]) =>
  SetMetadata(CHAVE_PERMISSOES, codigos);
