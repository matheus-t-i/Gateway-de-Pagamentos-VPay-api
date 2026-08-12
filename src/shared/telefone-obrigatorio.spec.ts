import { cadastroUsuarioSchema, pagadorCobrancaSchema } from './schemas';

describe('telefone obrigatório (cadastro e PIX in)', () => {
  const endereco = {
    cep: '01310100',
    logradouro: 'Avenida Paulista',
    numero: '1000',
    bairro: 'Bela Vista',
    cidade: 'São Paulo',
    uf: 'SP',
  };

  it('pagador sem telefone é recusado', () => {
    const r = pagadorCobrancaSchema.safeParse({
      nome: 'Fulano de Tal',
      documento: '12345678909',
      email: 'fulano@email.com',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.flatten().fieldErrors.telefone).toBeTruthy();
  });

  it('pagador aceita máscara e grava só dígitos', () => {
    const r = pagadorCobrancaSchema.safeParse({
      nome: 'Fulano de Tal',
      documento: '12345678909',
      email: 'fulano@email.com',
      telefone: '(11) 99999-8888',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.telefone).toBe('11999998888');
  });

  it('cadastro sem telefone é recusado', () => {
    const r = cadastroUsuarioSchema.safeParse({
      tipoPessoa: 'PF',
      cpfCnpj: '52998224725',
      nomeRazaoSocial: 'Fulano de Tal',
      email: 'fulano@email.com',
      senha: 'SenhaForte1!',
      endereco,
      faturamentoMensalMedio: '10000.00',
      aceites: { termosUso: true, contratoIntermediacao: true },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.flatten().fieldErrors.telefone).toBeTruthy();
  });
});
