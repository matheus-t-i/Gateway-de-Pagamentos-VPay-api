import {
  chavePixParaLiquidante,
  chavePixValida,
  digitosTelefoneChavePix,
  normalizarChavePixCadastro,
} from './chave-pix';
import {
  criarChavePixSchema,
  criarSaquePixSchema,
  editarChavePixAdminSchema,
} from './schemas';

const totp = '123456';

function cadastro(tipo: string, chave: string) {
  const doc =
    tipo === 'CPF' || tipo === 'CNPJ' ? chave : '12345678909';
  return criarChavePixSchema.safeParse({
    chave,
    tipoChave: tipo,
    nomeTitular: 'Fulano de Tal',
    documentoTitular: doc,
    codigoTotp: totp,
  });
}

describe('chave PIX — cadastro sem +55, liquidante com +55', () => {
  it('TELEFONE grava só DDD + número (10 ou 11 dígitos)', () => {
    const r = cadastro('TELEFONE', '(11) 99999-8888');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.chave).toBe('11999998888');
  });

  it('cola +5511999998888 ou 5511999998888 e persiste 11999998888', () => {
    for (const bruto of ['+5511999998888', '5511999998888', '+55 (11) 99999-8888']) {
      const r = cadastro('TELEFONE', bruto);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.chave).toBe('11999998888');
    }
  });

  it('não confunde DDD 55 (10/11 dígitos) com código do país', () => {
    expect(digitosTelefoneChavePix('55999998888')).toBe('55999998888');
    expect(cadastro('TELEFONE', '55999998888').success).toBe(true);
  });

  it('revalidação aceita o valor gravado (sem +55)', () => {
    expect(chavePixValida('TELEFONE', '11999998888')).toBe(true);
    expect(chavePixValida('TELEFONE', '1133334444')).toBe(true);
    expect(chavePixValida('TELEFONE', '+5511999998888')).toBe(false);
    expect(chavePixValida('TELEFONE', '5511999998888')).toBe(false);
  });

  it('envio à liquidante monta E.164 com +55', () => {
    expect(chavePixParaLiquidante('TELEFONE', '11999998888')).toBe('+5511999998888');
    expect(chavePixParaLiquidante('TELEFONE', '(11) 99999-8888')).toBe(
      '+5511999998888',
    );
    // Idempotente se o caller já passou E.164.
    expect(chavePixParaLiquidante('TELEFONE', '+5511999998888')).toBe(
      '+5511999998888',
    );
    expect(chavePixParaLiquidante('EMAIL', 'loja@destino.com')).toBe(
      'loja@destino.com',
    );
  });

  it('schema recusa chave incompatível com o tipo', () => {
    expect(cadastro('CPF', 'loja@destino.com').success).toBe(false);
    expect(cadastro('CPF', '1234567890').success).toBe(false);
    expect(cadastro('CNPJ', '12345678909').success).toBe(false);
    expect(cadastro('EMAIL', '11999998888').success).toBe(false);
    expect(cadastro('TELEFONE', 'nao-e-telefone').success).toBe(false);
    expect(cadastro('ALEATORIA', 'nao-e-uuid').success).toBe(false);
    expect(cadastro('ALEATORIA', '12345678909').success).toBe(false);
  });

  it('CPF, CNPJ, e-mail e UUID válidos passam e saem normalizados', () => {
    const cpf = cadastro('CPF', '123.456.789-09');
    expect(cpf.success).toBe(true);
    if (cpf.success) expect(cpf.data.chave).toBe('12345678909');

    const cnpj = cadastro('CNPJ', '12.345.678/0001-95');
    expect(cnpj.success).toBe(true);
    if (cnpj.success) expect(cnpj.data.chave).toBe('12345678000195');

    const email = cadastro('EMAIL', '  Loja@Destino.COM ');
    expect(email.success).toBe(true);
    if (email.success) expect(email.data.chave).toBe('loja@destino.com');

    const uuid = cadastro('ALEATORIA', 'A1B2C3D4E5F60718293A4B5C6D7E8F90');
    expect(uuid.success).toBe(true);
    if (uuid.success) {
      expect(uuid.data.chave).toBe('a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90');
    }
  });

  it('saque via API também normaliza TELEFONE e recusa tipo↔chave cruzados', () => {
    const base = {
      valor: '10.00',
      nomeBeneficiario: 'Fulano de Tal',
      documentoBeneficiario: '12345678909',
    };
    const ok = criarSaquePixSchema.safeParse({
      ...base,
      chavePix: '+5511999998888',
      tipoChavePix: 'TELEFONE',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.chavePix).toBe('11999998888');

    const cruzado = criarSaquePixSchema.safeParse({
      ...base,
      chavePix: 'loja@destino.com',
      tipoChavePix: 'CPF',
    });
    expect(cruzado.success).toBe(false);

    const cpfOk = criarSaquePixSchema.safeParse({
      ...base,
      chavePix: '123.456.789-09',
      tipoChavePix: 'CPF',
    });
    expect(cpfOk.success).toBe(true);
    if (cpfOk.success) expect(cpfOk.data.chavePix).toBe('12345678909');
  });

  it('cadastro recusa chave sem titular ou documento', () => {
    expect(
      criarChavePixSchema.safeParse({
        chave: '11999998888',
        tipoChave: 'TELEFONE',
        codigoTotp: totp,
      }).success,
    ).toBe(false);
    expect(
      criarChavePixSchema.safeParse({
        chave: '11999998888',
        tipoChave: 'TELEFONE',
        nomeTitular: 'Fulano',
        codigoTotp: totp,
      }).success,
    ).toBe(false);
  });

  it('quando a chave é CPF, o documento do titular tem que ser o mesmo', () => {
    const ok = criarChavePixSchema.safeParse({
      chave: '123.456.789-09',
      tipoChave: 'CPF',
      nomeTitular: 'Fulano de Tal',
      documentoTitular: '12345678909',
      codigoTotp: totp,
    });
    expect(ok.success).toBe(true);

    const cruzado = criarChavePixSchema.safeParse({
      chave: '123.456.789-09',
      tipoChave: 'CPF',
      nomeTitular: 'Fulano de Tal',
      documentoTitular: '98765432100',
      codigoTotp: totp,
    });
    expect(cruzado.success).toBe(false);
  });

  it('edição admin exige titular e documento válidos', () => {
    expect(
      editarChavePixAdminSchema.safeParse({
        nomeTitular: 'Fulano de Tal',
        documentoTitular: '123.456.789-09',
        codigoTotp: totp,
      }).success,
    ).toBe(true);
    expect(
      editarChavePixAdminSchema.safeParse({
        nomeTitular: 'F',
        documentoTitular: '12345678909',
        codigoTotp: totp,
      }).success,
    ).toBe(false);
    expect(
      editarChavePixAdminSchema.safeParse({
        nomeTitular: 'Fulano de Tal',
        documentoTitular: 'abc',
        codigoTotp: totp,
      }).success,
    ).toBe(false);
  });

  it('normalizarChavePixCadastro é a fonte do valor gravado', () => {
    expect(normalizarChavePixCadastro('TELEFONE', '+5511988887777')).toBe(
      '11988887777',
    );
    expect(normalizarChavePixCadastro('CPF', '529.982.247-25')).toBe('52998224725');
  });
});
