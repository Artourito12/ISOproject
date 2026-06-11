-- ============================================================
-- ISOproject — migration 2 : super admin plateforme +
-- génération de référentiels à la demande
-- ============================================================

-- Super admins plateforme (équipe ISOproject, pas les clients)
create table platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;

create policy "platform_admins : lecture de sa propre ligne"
  on platform_admins for select
  using (user_id = auth.uid());

-- Écriture uniquement via service role.

-- Traçabilité des référentiels : origine (manuel vs généré par IA)
-- et validation par un expert (super admin)
alter table standard_versions
  add column origin text not null default 'manual' check (origin in ('manual', 'ai')),
  add column validated_at timestamptz,
  add column validated_by uuid references auth.users(id);

-- Les 4 référentiels déjà publiés ont été rédigés et relus manuellement
update standard_versions set validated_at = now();

-- Demandes de normes (déclenchées par la barre de recherche client)
create table standard_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid references profiles(id),
  query text not null,
  status text not null default 'en_cours'
    check (status in ('en_cours', 'traitee', 'erreur')),
  standard_id uuid references standards(id),
  error_message text,
  created_at timestamptz not null default now()
);

alter table standard_requests enable row level security;

create policy "standard_requests : lecture par organisation"
  on standard_requests for select
  using (organization_id = current_org_id());

-- Création/mise à jour uniquement via service role (api/standards/generate).

create index idx_standard_requests_org on standard_requests(organization_id);
