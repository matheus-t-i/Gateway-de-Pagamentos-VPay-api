-- Role de aplicação (least privilege / defesa em profundidade).
--
-- A API e o Worker passam a conectar como MEMBRO de `vpay_aplicacao`: DML
-- (SELECT/INSERT/UPDATE/DELETE) e sequences, NADA de DDL, ownership, TRUNCATE,
-- REFERENCES nem TRIGGER. As migrations continuam rodando como o OWNER do
-- banco (`directUrl` do Prisma / `DIRECT_DATABASE_URL`).
--
-- Sem esta separação, qualquer injection futura rodaria com poder de owner —
-- e uma RLS futura sem `FORCE` seria silenciosamente ignorada, porque owner
-- bypassa policy. Este role é o pré-requisito estrutural do RLS.
--
-- O role é NOLOGIN de propósito: senha não pode viver em migration versionada.
-- Cada ambiente cria o PRÓPRIO usuário de login como membro (herda os grants):
--   CREATE USER vpay_app LOGIN PASSWORD '<segredo>' IN ROLE vpay_aplicacao;
-- Local: ver .env.example. Produção: RUNBOOK-GOLIVE.md §0.
--
-- CREATE ROLE é do CLUSTER, não do banco — o IF NOT EXISTS manual cobre o
-- shadow database do `migrate dev`, que roda esta migration de novo no mesmo
-- cluster.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vpay_aplicacao') THEN
    CREATE ROLE vpay_aplicacao NOLOGIN;
  END IF;
END
$$;

-- Dinâmico porque o nome do banco varia por ambiente (vpay local, gerado no Render).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vpay_aplicacao', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO vpay_aplicacao;

-- Tabelas existentes (inclui _prisma_migrations — leitura inofensiva).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vpay_aplicacao;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vpay_aplicacao;

-- Objetos FUTUROS: migrations rodam como owner, então estes defaults valem
-- para o que as PRÓXIMAS migrations criarem. Sem isto, cada tabela nova
-- nasceria invisível para a aplicação e o erro só apareceria em produção,
-- na primeira query.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vpay_aplicacao;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vpay_aplicacao;
