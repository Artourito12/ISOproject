-- ============================================================
-- Audit global (cahier des charges §6-§7) : colonnes de suivi
-- d'exécution et de restitution sur global_audits.
-- ============================================================

alter table global_audits
  add column if not exists progress jsonb,            -- {etape, faits, total} mis à jour pendant l'exécution
  add column if not exists summary text,              -- synthèse rédigée de l'audit (vouvoiement)
  add column if not exists score_by_chapter jsonb,    -- {"4": 80, "5": 100, ...} score par chapitre de la norme
  add column if not exists coherence jsonb,           -- contradictions inter-documents détectées
  add column if not exists error_message text;

create index if not exists idx_global_audits_project on global_audits(project_id, started_at desc);
