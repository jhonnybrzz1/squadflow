-- Demanda 10091: catálogo local de frameworks de Product Discovery.
-- Criação também ocorre em runtime via pmFrameworksService.ensureSchema();
-- este arquivo mantém paridade com o tooling de migrations.
CREATE TABLE IF NOT EXISTS pm_frameworks (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  version TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pm_frameworks_slug_idx ON pm_frameworks(slug);
