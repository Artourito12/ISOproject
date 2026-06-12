-- ============================================================
-- Multi-utilisateurs (phase 3) : invitations à rejoindre une
-- organisation, par lien. L'email part via Resend quand le SMTP
-- sera configuré ; en attendant le lien se copie depuis l'UI.
-- ============================================================

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'membre' check (role in ('admin', 'membre')),
  token uuid not null unique default gen_random_uuid(),
  status text not null default 'en_attente'
    check (status in ('en_attente', 'acceptee', 'revoquee')),
  invited_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);

alter table invitations enable row level security;

-- Lecture par les membres de l'organisation ; toute écriture passe par api/* (service role).
create policy "invitations : lecture par organisation" on invitations
  for select using (organization_id = current_org_id());

create index if not exists idx_invitations_org on invitations(organization_id, status);

-- Email affiché dans la page Équipe (renseigné à l'acceptation / création de compte).
alter table profiles add column if not exists email text;
