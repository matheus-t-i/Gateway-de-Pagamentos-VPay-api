import { atualizarPerfilSchema, atualizarTemaSchema, TEMAS } from '../shared';

/**
 * Trocar claro/escuro pedia o código do autenticador, porque o tema ia junto
 * no `PATCH /auth/me` — endpoint que exige step-up para proteger telefone e
 * nome fantasia. A rota do tema é separada e SEM step-up; estes casos travam
 * as duas metades disso: o tema entra sem código, e nada além do tema entra
 * por ali.
 */
describe('atualizarTemaSchema — tema sem 2FA, e só o tema', () => {
  it('aceita o tema sem codigoTotp', () => {
    const r = atualizarTemaSchema.safeParse({ temaPreferido: TEMAS.ESCURO });
    expect(r.success).toBe(true);
  });

  it('aceita os três temas do catálogo', () => {
    for (const tema of [TEMAS.PADRAO, TEMAS.CLARO, TEMAS.ESCURO]) {
      expect(atualizarTemaSchema.safeParse({ temaPreferido: tema }).success).toBe(
        true,
      );
    }
  });

  it('recusa tema fora do catálogo', () => {
    expect(
      atualizarTemaSchema.safeParse({ temaPreferido: 'NEON' }).success,
    ).toBe(false);
    expect(atualizarTemaSchema.safeParse({}).success).toBe(false);
  });

  it('NÃO é porta dos fundos: telefone/nome enviados aqui são descartados', () => {
    const r = atualizarTemaSchema.safeParse({
      temaPreferido: TEMAS.CLARO,
      telefone: '11999998888',
      nomeFantasia: 'Invadida',
    });
    expect(r.success).toBe(true);
    // O `update` grava a partir do parse — o que não está aqui não chega ao banco.
    expect(r.success && r.data).toEqual({ temaPreferido: TEMAS.CLARO });
  });

  it('o perfil continua exigindo codigoTotp', () => {
    expect(
      atualizarPerfilSchema.safeParse({ telefone: '11999998888' }).success,
    ).toBe(false);
    expect(
      atualizarPerfilSchema.safeParse({
        telefone: '11999998888',
        codigoTotp: '123456',
      }).success,
    ).toBe(true);
  });
});
