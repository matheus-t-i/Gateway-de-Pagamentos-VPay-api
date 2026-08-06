/**
 * Regras de força de senha — FONTE ÚNICA.
 *
 * Espelhado em `src/lib/senha.ts` do painel (mesmo conteúdo). O painel usa para
 * marcar as regras em tempo real enquanto o usuário digita; a API usa para
 * recusar — a checagem do servidor é a que vale, a da tela é conveniência.
 */

/** Três ou mais dígitos iguais (111) ou em sequência (123 / 321). */
function temSequenciaOuRepeticaoNumerica(senha: string): boolean {
  const digitos = [...senha].map((c) => (/\d/.test(c) ? Number(c) : null));
  let iguais = 1;
  let subindo = 1;
  let descendo = 1;

  for (let i = 1; i < digitos.length; i++) {
    const atual = digitos[i];
    const anterior = digitos[i - 1];
    if (atual === null || anterior === null) {
      iguais = subindo = descendo = 1;
      continue;
    }
    iguais = atual === anterior ? iguais + 1 : 1;
    subindo = atual === anterior + 1 ? subindo + 1 : 1;
    descendo = atual === anterior - 1 ? descendo + 1 : 1;
    if (iguais >= 3 || subindo >= 3 || descendo >= 3) return true;
  }
  return false;
}

/** Três ou mais letras iguais em seguida (aaa), ignorando maiúsc./minúsc. */
function temLetraRepetida(senha: string): boolean {
  let repetidas = 1;
  for (let i = 1; i < senha.length; i++) {
    const atual = senha[i].toLowerCase();
    const anterior = senha[i - 1].toLowerCase();
    if (/[a-zà-ÿ]/i.test(atual) && atual === anterior) {
      repetidas++;
      if (repetidas >= 3) return true;
    } else {
      repetidas = 1;
    }
  }
  return false;
}

export type RegraSenha = {
  id: string;
  texto: string;
  ok: (senha: string) => boolean;
};

/** Ordem das regras = ordem exibida no painel. */
export const REGRAS_SENHA: RegraSenha[] = [
  {
    id: 'tamanho',
    texto: 'Deve conter no mínimo 8 caracteres',
    ok: (s) => s.length >= 8,
  },
  {
    id: 'numero',
    texto: 'Deve conter no mínimo um número',
    ok: (s) => /\d/.test(s),
  },
  {
    id: 'letra',
    texto: 'Deve conter no mínimo uma letra',
    ok: (s) => /[a-zà-ÿ]/i.test(s),
  },
  {
    id: 'numeros-sequenciais',
    texto: 'Não pode conter 3 ou mais números sequenciais e/ou repetidos',
    ok: (s) => !temSequenciaOuRepeticaoNumerica(s),
  },
  {
    id: 'letras-repetidas',
    texto: 'Não pode conter 3 ou mais letras repetidas',
    ok: (s) => !temLetraRepetida(s),
  },
];

/** Limite superior: argon2 aceita mais, mas nada justifica senha gigante. */
export const TAMANHO_MAXIMO_SENHA = 128;

/** Mensagens das regras que a senha NÃO cumpre (vazio = senha aceita). */
export function violacoesSenha(senha: string): string[] {
  const falhas = REGRAS_SENHA.filter((r) => !r.ok(senha)).map((r) => r.texto);
  if (senha.length > TAMANHO_MAXIMO_SENHA) {
    falhas.push(`Deve ter no máximo ${TAMANHO_MAXIMO_SENHA} caracteres`);
  }
  return falhas;
}

export function senhaForte(senha: string): boolean {
  return violacoesSenha(senha).length === 0;
}
