-- ============================================================
-- ISOproject — schéma initial
-- Socle multi-tenant + référentiels + projets + génération + audits
-- RLS activée sur toutes les tables dès cette migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Socle multi-tenant
-- ------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'trial',
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  role text not null default 'membre' check (role in ('admin', 'membre')),
  full_name text,
  created_at timestamptz not null default now()
);

-- Fonction utilitaire : organisation de l'utilisateur courant.
-- security definer pour éviter la récursion RLS sur profiles.
create or replace function current_org_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select organization_id from profiles where id = auth.uid()
$$;

alter table organizations enable row level security;
alter table profiles enable row level security;

create policy "org : lecture par ses membres"
  on organizations for select
  using (id = current_org_id());

create policy "org : modification par admin"
  on organizations for update
  using (id = current_org_id()
         and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

create policy "profiles : lecture même organisation"
  on profiles for select
  using (organization_id = current_org_id() or id = auth.uid());

create policy "profiles : modification de son propre profil"
  on profiles for update
  using (id = auth.uid());

-- Création d'organisation et de profil : réservée au service role (api/onboarding).

-- ------------------------------------------------------------
-- 2. Référentiels de normes (partagés, lecture seule pour les clients)
--    Écriture uniquement via service role (scripts/seed-referentiel.mjs).
-- ------------------------------------------------------------

create table standards (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,            -- 'iso9001'
  name text not null,                   -- 'ISO 9001 — Management de la qualité'
  description text,
  is_active boolean not null default true
);

create table standard_versions (
  id uuid primary key default gen_random_uuid(),
  standard_id uuid not null references standards(id) on delete cascade,
  edition text not null,                -- '2015' (édition officielle de la norme)
  referential_version text not null,    -- semver de NOTRE référentiel ('1.0.0')
  published_at timestamptz not null default now(),
  is_current boolean not null default false,
  unique (standard_id, edition, referential_version)
);

create table clauses (
  id uuid primary key default gen_random_uuid(),
  standard_version_id uuid not null references standard_versions(id) on delete cascade,
  parent_clause_id uuid references clauses(id) on delete cascade,
  number text not null,                 -- '7.5.1'
  title text not null,
  requirement_text text,                -- énoncé synthétique reformulé (texte officiel protégé)
  sort_order int not null default 0,
  unique (standard_version_id, number)
);

create table required_documents (
  id uuid primary key default gen_random_uuid(),
  standard_version_id uuid not null references standard_versions(id) on delete cascade,
  key text not null,                    -- 'politique_qualite'
  title text not null,
  description text,                     -- ce qui est attendu, affiché dans l'encart
  evidence_type text not null,          -- document_redige | enregistrement | preuve_externe
  is_mandatory boolean not null default true,
  generation_case int not null check (generation_case in (1, 2, 3)),
  field_schema jsonb,                   -- Cas 1 : champs obligatoires de l'entretien
  source_hints jsonb,                   -- Cas 2 : documents sources attendus
  generation_template text,             -- Cas 1 & 2 : modèle de génération
  validation_rules jsonb,               -- règles formelles (version, date de revue, approbation)
  sort_order int not null default 0,
  unique (standard_version_id, key)
);

create table clause_documents (
  clause_id uuid not null references clauses(id) on delete cascade,
  required_document_id uuid not null references required_documents(id) on delete cascade,
  primary key (clause_id, required_document_id)
);

alter table standards enable row level security;
alter table standard_versions enable row level security;
alter table clauses enable row level security;
alter table required_documents enable row level security;
alter table clause_documents enable row level security;

create policy "standards : lecture authentifiée" on standards
  for select using (auth.role() = 'authenticated');
create policy "standard_versions : lecture authentifiée" on standard_versions
  for select using (auth.role() = 'authenticated');
create policy "clauses : lecture authentifiée" on clauses
  for select using (auth.role() = 'authenticated');
create policy "required_documents : lecture authentifiée" on required_documents
  for select using (auth.role() = 'authenticated');
create policy "clause_documents : lecture authentifiée" on clause_documents
  for select using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 3. Projets de certification (données client)
-- ------------------------------------------------------------

create table projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'en_cours'
    check (status in ('en_cours', 'audit', 'correction', 'finalise')),
  created_at timestamptz not null default now()
);

create table project_standards (
  project_id uuid not null references projects(id) on delete cascade,
  standard_version_id uuid not null references standard_versions(id),
  primary key (project_id, standard_version_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  storage_path text not null,
  mime_type text,
  origin text not null check (origin in ('uploaded', 'generated')),
  current_version int not null default 1,
  created_at timestamptz not null default now()
);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version int not null,
  storage_path text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

-- Table pivot des ENCARTS : une ligne par élément à fournir.
create table document_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  required_document_id uuid not null references required_documents(id),
  document_id uuid references documents(id) on delete set null,
  status text not null default 'a_fournir'
    check (status in ('a_fournir', 'en_cours', 'fourni', 'valide')),
  classification_confidence numeric,
  classification_confirmed_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  unique (project_id, required_document_id)
);

-- ------------------------------------------------------------
-- 4. Génération assistée
-- ------------------------------------------------------------

create table generation_sessions (
  id uuid primary key default gen_random_uuid(),
  document_requirement_id uuid not null references document_requirements(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  generation_case int not null check (generation_case in (1, 2)),
  status text not null default 'collecte'
    check (status in ('collecte', 'extraction', 'generation', 'revue', 'termine')),
  collected_fields jsonb not null default '{}',
  transcript jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table extraction_sources (
  id uuid primary key default gen_random_uuid(),
  generation_session_id uuid not null references generation_sessions(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  extracted_data jsonb,                 -- chaque donnée : {value, source_excerpt, confirmed}
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5. Audits
-- ------------------------------------------------------------

create table document_audits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  document_version int not null,
  status text not null default 'en_cours'
    check (status in ('en_cours', 'conforme', 'non_conforme')),
  findings jsonb,                       -- {ecarts: [], suggestions: [], questions: []}
  created_at timestamptz not null default now()
);

create table global_audits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  status text not null default 'en_cours'
    check (status in ('en_cours', 'termine', 'erreur')),
  compliance_score numeric,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table audit_findings (
  id uuid primary key default gen_random_uuid(),
  global_audit_id uuid not null references global_audits(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  clause_id uuid not null references clauses(id),
  document_id uuid references documents(id) on delete set null,
  verdict text not null
    check (verdict in ('conforme', 'nc_majeure', 'nc_mineure', 'opportunite')),
  explanation text not null,            -- explicabilité : clause + document + raison
  recommendation text,
  criticality int not null default 0,
  status text not null default 'ouvert'
    check (status in ('ouvert', 'corrige', 'reaudite')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. Dossier final
-- ------------------------------------------------------------

create table dossier_exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  global_audit_id uuid references global_audits(id),
  storage_path text,
  correspondence_table jsonb,           -- exigence ↔ preuve
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 7. RLS données client : isolation stricte par organisation
-- ------------------------------------------------------------

alter table projects enable row level security;
alter table project_standards enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table document_requirements enable row level security;
alter table generation_sessions enable row level security;
alter table extraction_sources enable row level security;
alter table document_audits enable row level security;
alter table global_audits enable row level security;
alter table audit_findings enable row level security;
alter table dossier_exports enable row level security;

create policy "projects : tout par organisation" on projects
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create policy "project_standards : tout par organisation" on project_standards
  for all using (exists (select 1 from projects p
                         where p.id = project_id and p.organization_id = current_org_id()));

create policy "documents : tout par organisation" on documents
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create policy "document_versions : tout par organisation" on document_versions
  for all using (exists (select 1 from documents d
                         where d.id = document_id and d.organization_id = current_org_id()));

create policy "document_requirements : tout par organisation" on document_requirements
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create policy "generation_sessions : tout par organisation" on generation_sessions
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create policy "extraction_sources : tout par organisation" on extraction_sources
  for all using (organization_id = current_org_id())
  with check (organization_id = current_org_id());

create policy "document_audits : lecture par organisation" on document_audits
  for select using (organization_id = current_org_id());

create policy "global_audits : lecture par organisation" on global_audits
  for select using (organization_id = current_org_id());

create policy "audit_findings : lecture par organisation" on audit_findings
  for select using (organization_id = current_org_id());

create policy "audit_findings : mise à jour statut par organisation" on audit_findings
  for update using (organization_id = current_org_id());

create policy "dossier_exports : lecture par organisation" on dossier_exports
  for select using (organization_id = current_org_id());

-- Les audits et exports sont CRÉÉS par les fonctions api/* (service role) uniquement.

-- ------------------------------------------------------------
-- 8. Storage : bucket privé 'documents', chemin {organization_id}/...
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false);

create policy "storage documents : lecture par organisation"
  on storage.objects for select
  using (bucket_id = 'documents'
         and (storage.foldername(name))[1] = current_org_id()::text);

create policy "storage documents : écriture par organisation"
  on storage.objects for insert
  with check (bucket_id = 'documents'
              and (storage.foldername(name))[1] = current_org_id()::text);

create policy "storage documents : suppression par organisation"
  on storage.objects for delete
  using (bucket_id = 'documents'
         and (storage.foldername(name))[1] = current_org_id()::text);

-- ------------------------------------------------------------
-- 9. Index
-- ------------------------------------------------------------

create index idx_profiles_org on profiles(organization_id);
create index idx_clauses_version on clauses(standard_version_id);
create index idx_required_documents_version on required_documents(standard_version_id);
create index idx_projects_org on projects(organization_id);
create index idx_documents_project on documents(project_id);
create index idx_doc_requirements_project on document_requirements(project_id);
create index idx_doc_requirements_status on document_requirements(project_id, status);
create index idx_generation_sessions_req on generation_sessions(document_requirement_id);
create index idx_document_audits_doc on document_audits(document_id);
create index idx_audit_findings_audit on audit_findings(global_audit_id);
