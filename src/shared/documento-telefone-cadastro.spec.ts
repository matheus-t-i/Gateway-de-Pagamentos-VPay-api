import {
  cnpjTemDigitosValidos,
  cpfTemDigitosValidos,
  documentoValidoPara,
  MENSAGEM_DOCUMENTO,
  motivoDocumentoInvalido,
} from './documento';
import {
  MENSAGEM_TELEFONE,
  motivoTelefoneInvalido,
  normalizarTelefone,
  telefoneContatoValido,
} from './telefone';
import {
  atualizarPerfilSchema,
  cadastroUsuarioSchema,
  editarDadosCadastraisAdminSchema,
  pagadorCobrancaSchema,
} from './schemas';

/**
 * Cadastro exige documento com dígito verificador e telefone que exista.
 * `000.000.000-00`, `123.456.789-00` e `(00) 00000-0000` passavam: só o
 * TAMANHO era conferido, e o painel de aprovação enchia de conta com dado
 * inventado (`teste teste`, CPF zerado, telefone zerado).
 */
describe('CPF/CNPJ — dígitos verificadores', () => {
  it('aceita CPFs reais e recusa DV errado / sequência repetida', () => {
    for (const cpf of ['52998224725', '39053344705', '12345678909', '16899535009']) {
      expect(cpfTemDigitosValidos(cpf)).toBe(true);
    }
    expect(cpfTemDigitosValidos('52998224726')).toBe(false); // último dígito trocado
    expect(cpfTemDigitosValidos('12345678900')).toBe(false); // o "clássico" digitado
    expect(cpfTemDigitosValidos('00000000000')).toBe(false);
    expect(cpfTemDigitosValidos('11111111111')).toBe(false); // fecha o módulo 11, mas é falso
    expect(cpfTemDigitosValidos('5299822472')).toBe(false); // 10 dígitos
    expect(cpfTemDigitosValidos('529982247250')).toBe(false); // 12 dígitos
  });

  it('aceita CNPJ numérico e ALFANUMÉRICO reais; recusa DV errado e zeros', () => {
    expect(cnpjTemDigitosValidos('11444777000161')).toBe(true);
    expect(cnpjTemDigitosValidos('19131243000197')).toBe(true);
    // Exemplo oficial da Receita para o CNPJ alfanumérico: 12.ABC.345/01DE-35.
    expect(cnpjTemDigitosValidos('12ABC34501DE35')).toBe(true);

    expect(cnpjTemDigitosValidos('11444777000162')).toBe(false);
    expect(cnpjTemDigitosValidos('12ABC34501DE36')).toBe(false);
    expect(cnpjTemDigitosValidos('12345678000199')).toBe(false); // o "clássico" digitado
    // `00.000.000/0000-00` FECHA o módulo 11 — tem que ser recusado explicitamente.
    expect(cnpjTemDigitosValidos('00000000000000')).toBe(false);
    // Letra nas posições de DV nunca vale.
    expect(cnpjTemDigitosValidos('12ABC34501DE3A')).toBe(false);
  });

  it('documentoValidoPara casa o tipo de pessoa e exige DV', () => {
    expect(documentoValidoPara('PF', '52998224725')).toBe(true);
    expect(documentoValidoPara('PF', '11444777000161')).toBe(false); // CNPJ onde se espera CPF
    expect(documentoValidoPara('PJ', '11444777000161')).toBe(true);
    expect(documentoValidoPara('PJ', '52998224725')).toBe(false);
    expect(documentoValidoPara('PF', '00000000000')).toBe(false);
  });

  it('motivo distingue formato de dígito verificador (mensagem única API/painel)', () => {
    expect(motivoDocumentoInvalido('PF', '529.982.247-25')).toBeNull(); // aceita máscara
    expect(motivoDocumentoInvalido('PF', '529.982.247-2')).toBe(MENSAGEM_DOCUMENTO.CPF_FORMATO);
    expect(motivoDocumentoInvalido('PF', '529.982.247-26')).toBe(MENSAGEM_DOCUMENTO.CPF_DV);
    expect(motivoDocumentoInvalido('PJ', '11.444.777/0001-61')).toBeNull();
    expect(motivoDocumentoInvalido('PJ', '11.444.777/0001-6')).toBe(
      MENSAGEM_DOCUMENTO.CNPJ_FORMATO,
    );
    expect(motivoDocumentoInvalido('PJ', '11.444.777/0001-62')).toBe(MENSAGEM_DOCUMENTO.CNPJ_DV);
  });
});

describe('telefone de contato da conta', () => {
  it('normaliza máscara, +55 e zero de tronco para DDD+número', () => {
    expect(normalizarTelefone('(11) 99999-8888')).toBe('11999998888');
    expect(normalizarTelefone('+55 11 99999-8888')).toBe('11999998888');
    expect(normalizarTelefone('5511999998888')).toBe('11999998888');
    expect(normalizarTelefone('011 99999-8888')).toBe('11999998888');
    // DDD 55 (Santa Maria/RS) de 11 dígitos NÃO é país: fica intacto.
    expect(normalizarTelefone('55 99999-8888')).toBe('55999998888');
  });

  it('aceita celular com 9 e fixo com 2–5 em DDD real', () => {
    expect(telefoneContatoValido('(11) 99999-8888')).toBe(true);
    expect(telefoneContatoValido('11988887777')).toBe(true);
    expect(telefoneContatoValido('(21) 3333-4444')).toBe(true);
    expect(telefoneContatoValido('(85) 4002-8922')).toBe(true);
    expect(telefoneContatoValido('+55 (47) 98888-1234')).toBe(true);
    expect(telefoneContatoValido('55 99123-4567')).toBe(true); // DDD 55
  });

  it('recusa vazio, tamanho errado, DDD inexistente, celular sem 9, fixo fora de 2–5 e repetido', () => {
    expect(motivoTelefoneInvalido('')).toBe(MENSAGEM_TELEFONE.OBRIGATORIO);
    expect(motivoTelefoneInvalido('123')).toBe(MENSAGEM_TELEFONE.TAMANHO);
    expect(motivoTelefoneInvalido('119999988881')).toBe(MENSAGEM_TELEFONE.TAMANHO); // 12 sem 55
    expect(motivoTelefoneInvalido('(00) 00000-0000')).toBe(MENSAGEM_TELEFONE.DDD);
    expect(motivoTelefoneInvalido('(10) 99999-8888')).toBe(MENSAGEM_TELEFONE.DDD);
    expect(motivoTelefoneInvalido('(20) 99999-8888')).toBe(MENSAGEM_TELEFONE.DDD);
    expect(motivoTelefoneInvalido('(11) 89999-8888')).toBe(MENSAGEM_TELEFONE.CELULAR);
    expect(motivoTelefoneInvalido('(11) 1234-5678')).toBe(MENSAGEM_TELEFONE.FIXO);
    expect(motivoTelefoneInvalido('(11) 9999-8888')).toBe(MENSAGEM_TELEFONE.FIXO); // 10 dígitos começando em 9
    expect(motivoTelefoneInvalido('(11) 99999-9999')).toBe(MENSAGEM_TELEFONE.REPETIDO);
    expect(motivoTelefoneInvalido('(11) 90000-0000')).toBe(MENSAGEM_TELEFONE.REPETIDO);
    expect(motivoTelefoneInvalido('(11) 3333-3333')).toBe(MENSAGEM_TELEFONE.REPETIDO);
  });
});

describe('schemas de cadastro / ficha / perfil aplicam as duas regras', () => {
  const endereco = {
    cep: '01310100',
    logradouro: 'Avenida Paulista',
    numero: '1000',
    bairro: 'Bela Vista',
    cidade: 'São Paulo',
    uf: 'SP',
  };
  const basePF = {
    tipoPessoa: 'PF' as const,
    cpfCnpj: '529.982.247-25',
    nomeRazaoSocial: 'Fulano de Tal',
    email: 'fulano@email.com',
    telefone: '(11) 99999-8888',
    senha: 'SenhaForte1!',
    endereco,
    faturamentoMensalMedio: '10000.00',
    aceites: { termosUso: true, contratoIntermediacao: true },
  };

  it('cadastro PF válido passa e grava documento/telefone normalizados', () => {
    const r = cadastroUsuarioSchema.safeParse(basePF);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cpfCnpj).toBe('52998224725');
      expect(r.data.telefone).toBe('11999998888');
    }
  });

  it('cadastro PF recusa CPF zerado / DV errado com a mensagem certa', () => {
    const zerado = cadastroUsuarioSchema.safeParse({ ...basePF, cpfCnpj: '000.000.000-00' });
    expect(zerado.success).toBe(false);
    if (!zerado.success) {
      expect(zerado.error.flatten().fieldErrors.cpfCnpj).toEqual([MENSAGEM_DOCUMENTO.CPF_DV]);
    }
    const dv = cadastroUsuarioSchema.safeParse({ ...basePF, cpfCnpj: '529.982.247-26' });
    expect(dv.success).toBe(false);
  });

  it('cadastro recusa telefone zerado / DDD inexistente / celular sem 9', () => {
    for (const telefone of ['(00) 00000-0000', '(10) 99999-8888', '(11) 89999-8888', '(11) 99999-9999']) {
      const r = cadastroUsuarioSchema.safeParse({ ...basePF, telefone });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.flatten().fieldErrors.telefone).toBeTruthy();
    }
  });

  it('cadastro PJ exige CNPJ com DV e CPF do responsável com DV', () => {
    const basePJ = {
      ...basePF,
      tipoPessoa: 'PJ' as const,
      cpfCnpj: '11.444.777/0001-61',
      responsavel: { cpf: '529.982.247-25', nome: 'Responsável' },
    };
    expect(cadastroUsuarioSchema.safeParse(basePJ).success).toBe(true);

    const cnpjErrado = cadastroUsuarioSchema.safeParse({ ...basePJ, cpfCnpj: '12.345.678/0001-99' });
    expect(cnpjErrado.success).toBe(false);
    if (!cnpjErrado.success) {
      expect(cnpjErrado.error.flatten().fieldErrors.cpfCnpj).toEqual([MENSAGEM_DOCUMENTO.CNPJ_DV]);
    }

    const respErrado = cadastroUsuarioSchema.safeParse({
      ...basePJ,
      responsavel: { cpf: '000.000.000-00', nome: 'Responsável' },
    });
    expect(respErrado.success).toBe(false);
    if (!respErrado.success) {
      const issue = respErrado.error.issues.find((i) => i.path.join('.') === 'responsavel.cpf');
      expect(issue?.message).toContain(MENSAGEM_DOCUMENTO.CPF_DV);
    }
  });

  it('CNPJ alfanumérico da Receita é aceito no cadastro PJ', () => {
    const r = cadastroUsuarioSchema.safeParse({
      ...basePF,
      tipoPessoa: 'PJ' as const,
      cpfCnpj: '12.ABC.345/01DE-35',
      responsavel: { cpf: '529.982.247-25', nome: 'Responsável' },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cpfCnpj).toBe('12ABC34501DE35');
  });

  it('ficha do admin usa a MESMA regra do cadastro', () => {
    const base = {
      tipoPessoa: 'PF' as const,
      cpfCnpj: '529.982.247-25',
      nomeRazaoSocial: 'Fulano de Tal',
      telefone: '+55 (11) 99999-8888',
      endereco,
      codigoTotp: '123456',
    };
    const ok = editarDadosCadastraisAdminSchema.safeParse(base);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.telefone).toBe('11999998888');
    expect(editarDadosCadastraisAdminSchema.safeParse({ ...base, cpfCnpj: '11111111111' }).success).toBe(false);
    expect(editarDadosCadastraisAdminSchema.safeParse({ ...base, telefone: '(11) 1111-1111' }).success).toBe(false);
  });

  it('perfil: telefone continua opcional, mas se vier tem que ser real', () => {
    expect(atualizarPerfilSchema.safeParse({ codigoTotp: '123456' }).success).toBe(true);
    const ok = atualizarPerfilSchema.safeParse({ telefone: '(11) 99999-8888', codigoTotp: '123456' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.telefone).toBe('11999998888');
    expect(
      atualizarPerfilSchema.safeParse({ telefone: '(00) 00000-0000', codigoTotp: '123456' }).success,
    ).toBe(false);
  });

  it('pagador da cobrança NÃO endurece: telefone estranho não perde venda', () => {
    const r = pagadorCobrancaSchema.safeParse({
      nome: 'Fulano de Tal',
      documento: '12345678909',
      email: 'fulano@email.com',
      telefone: '(00) 00000-0000',
    });
    expect(r.success).toBe(true);
  });
});
