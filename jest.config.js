/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  /**
   * UM arquivo de teste por vez — não é gosto, é consequência do banco.
   *
   * 15 specs rodam contra o Postgres de VERDADE (`DATABASE_URL`), porque o que
   * eles travam só existe lá: unique parcial do saque, `FOR UPDATE` do ledger,
   * foreign key da ativação. É um banco só, compartilhado, e alguns desses
   * specs mexem em linha GLOBAL — `config-padrao.spec.ts` esconde e restaura a
   * linha `padraoSistema` de `configuracoes_padrao_pix_usuarios`, que é
   * justamente a linha que `admin-usuarios.controller.ativar` lê para montar a
   * configuração de toda conta nova.
   *
   * Em paralelo isso quebra de duas formas, as duas observadas (~1 execução em
   * 6 ficava vermelha, em teste diferente a cada vez):
   *
   * - a linha está escondida quando outro spec ativa uma conta → 400 "Defina o
   *   Padrão de novos clientes";
   * - a linha que a ativação leu é apagada na restauração antes do `INSERT` →
   *   `Foreign key constraint violated:
   *   configuracoes_pix_usuarios_configuracao_padrao_origem_id_fkey`.
   *
   * Nenhuma das duas é bug de produção: é corrida entre specs. Mas suíte que
   * fica vermelha sozinha ensina a ignorar vermelho, e é o oposto do que estes
   * testes existem para fazer.
   *
   * O paralelismo aqui não paga: medido nesta suíte (49 arquivos, 305 casos),
   * serial e paralelo empatam — ~10 s nos dois —, porque o custo é o transform
   * do ts-jest, não a execução. Antes de reativar workers, isole o banco por
   * worker (schema próprio, migrado e semeado); só `maxWorkers` de volta traz
   * a intermitência junto.
   *
   * Duas execuções SIMULTÂNEAS (dois terminais, dois agentes, jobs de CI) são
   * assunto do advisory lock do globalSetup — `maxWorkers` não enxerga outro
   * processo.
   */
  maxWorkers: 1,
  /**
   * Antes de qualquer spec, nesta ordem: a TRAVA de execução única (advisory
   * lock no Postgres — segunda suíte no mesmo banco espera a vez ou falha
   * explicando quem segura) e o heal da linha `padraoSistema` deixada
   * escondida por execução interrompida (Ctrl-C, kill) — sem ele TODA execução
   * seguinte falhava, e o painel parava de ativar conta. Detalhe em
   * `src/testing/trava-suite.ts` e `src/testing/padrao-sistema-oculto.ts`.
   */
  globalSetup: "<rootDir>/testing/jest-global-setup.ts",
  /** Solta a trava e fecha a conexão que a segurava. */
  globalTeardown: "<rootDir>/testing/jest-global-teardown.ts",
};
