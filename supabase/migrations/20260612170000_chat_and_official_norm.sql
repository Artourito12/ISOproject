-- ============================================================
-- V0.21 : dépôt de la norme officielle (privée à l'organisation,
-- jamais partagée — le texte ISO est protégé) + sessions du chat IA.
-- ============================================================

create table if not exists official_standard_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  standard_id uuid not null references standards(id) on delete cascade,
  title text not null,
  storage_path text not null,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (organization_id, standard_id)
);

alter table official_standard_documents enable row level security;

create policy "normes officielles : tout par organisation" on official_standard_documents
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  transcript jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table chat_sessions enable row level security;

create policy "chat : tout par organisation" on chat_sessions
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create index if not exists idx_chat_sessions_project on chat_sessions(project_id, created_at desc);
