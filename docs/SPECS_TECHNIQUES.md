# Spécifications techniques — ISOproject
## Plateforme SaaS de préparation à la certification ISO

> Document compagnon du `CAHIER_DES_CHARGES.md`. Il traduit le cahier des charges fonctionnel
> en architecture concrète : stack, modèle de données, schéma des référentiels, pipeline IA,
> structure du repo et phasage MVP.

---

## 1. Stack technique

Identique à Heldert/Holbert (patterns éprouvés, infra déjà maîtrisée) :

| Couche | Choix | Notes |
|---|---|---|
| Frontend | React + Vite + TypeScript | SPA, vérif build via `npx tsc -b` (aligné Vercel) |
| Backend | Fonctions serverless Vercel `api/*.js` | **JS pur, aucune syntaxe TypeScript** (sinon FUNCTION_INVOCATION_FAILED) |
| Base de données | Supabase Postgres | RLS multi-organisation systématique |
| Auth | Supabase Auth | email/password + invitations |
| Stockage fichiers | Supabase Storage | bucket privé par organisation, URLs signées |
| IA | Claude API (`@anthropic-ai/sdk`) | voir §5 — modèles et patterns |
| Emails | Resend | notifications, invitations, relances actions correctives |
| Jobs asynchrones | QStash (Upstash) | audit global, génération longue, relances |
| Hébergement | Vercel | projet séparé de Heldert/Holbert |

Nouveau projet Supabase dédié (cloisonnement total des données — les dossiers ISO sont très sensibles).

---

## 2. Structure du repo

```
ISOproject/
├── docs/                        # cahier des charges, specs, décisions
├── referentiels/                # ★ référentiels de normes versionnés (source de vérité)
│   ├── schema.md                # documentation du format de référentiel
│   └── iso9001/
│       ├── meta.json            # code, édition (ex: 2015), version du référentiel
│       ├── clauses.json         # arbre des clauses + exigences
│       └── documents.json       # documents requis + triage + schémas de champs
├── api/                         # fonctions serverless Vercel (JS pur)
│   ├── _lib/                    # helpers partagés (supabase admin, claude, auth)
│   ├── documents/               # upload, classification, validation
│   ├── generation/              # triage, entretien, extraction, génération
│   ├── audits/                  # audit ciblé (par document) + audit global
│   └── dossier/                 # constitution et export du dossier final
├── src/                         # frontend React
│   ├── pages/
│   ├── components/
│   ├── contexts/                # AuthContext, OrganizationContext, ProjectContext
│   └── lib/                     # client supabase, api client
├── supabase/
│   └── migrations/              # schéma SQL versionné dès le départ (leçon Heldert : tout versionner)
├── scripts/
│   └── seed-referentiel.mjs     # charge referentiels/* en base (idempotent, par version)
└── vercel.json / package.json / tsconfig.json
```

**Principe** : les référentiels vivent en fichiers JSON dans le repo (revue de code, diff, versioning git) et sont **seedés en base** pour être requêtables. L'application lit toujours la base, jamais les fichiers — conformément au principe « pas de hardcode, lecture dynamique ».

---

## 3. Modèle de données (Supabase Postgres)

### 3.1 Socle multi-tenant

```
organizations          id, name, plan, created_at
profiles               id (= auth.users.id), organization_id, role (admin|membre), full_name
```

RLS sur **toutes** les tables métier : `organization_id = (select organization_id from profiles where id = auth.uid())`.

### 3.2 Référentiels (données partagées, lecture seule pour les clients)

```
standards              id, code ('iso9001'), name, description, is_active
standard_versions      id, standard_id, edition ('2015'), referential_version (semver),
                       published_at, is_current
clauses                id, standard_version_id, parent_clause_id, number ('7.5.1'),
                       title, requirement_text, sort_order
required_documents     id, standard_version_id, key ('politique_qualite'), title,
                       description, evidence_type, is_mandatory,
                       generation_case (1|2|3),
                       field_schema jsonb,          -- Cas 1 : champs obligatoires de l'entretien
                       source_hints jsonb,          -- Cas 2 : types de documents sources attendus
                       generation_template text,    -- Cas 1 & 2 : modèle de génération
                       validation_rules jsonb       -- règles formelles (version, revue, approbation)
clause_documents       clause_id, required_document_id   -- N:N exigence ↔ document
```

Un projet est **épinglé** sur une `standard_version` : une révision de norme ne casse jamais un dossier en cours (même logique rétroactif-safe que `legal_rates` dans Heldert).

### 3.3 Projets de certification (données client)

```
projects               id, organization_id, name, status
                       (en_cours | audit | correction | finalise)
project_standards      project_id, standard_version_id        -- multi-normes possible
documents              id, project_id, organization_id, title, storage_path,
                       mime_type, origin (uploaded | generated),
                       status (a_fournir | en_cours | fourni | valide),
                       current_version int
document_versions      id, document_id, version, storage_path, created_by, created_at
document_requirements  id, project_id, required_document_id,
                       document_id nullable,                  -- null = encart vide
                       status (a_fournir | en_cours | fourni | valide),
                       classification_confidence numeric,
                       classification_confirmed_by uuid nullable   -- garde-fou humain
```

`document_requirements` matérialise **les encarts** (§5.2 du cahier des charges) : une ligne par
élément à fournir, créée à la sélection de la norme. C'est la table pivot de toute l'UI de complétion.

### 3.4 Génération assistée

```
generation_sessions    id, document_requirement_id, case (1|2),
                       status (collecte | extraction | generation | revue | termine),
                       collected_fields jsonb,      -- Cas 1 : réponses de l'entretien, champ par champ
                       transcript jsonb             -- historique de l'entretien (messages)
extraction_sources     id, generation_session_id, document_id,        -- Cas 2 : docs sources déposés
                       extracted_data jsonb         -- données extraites AVEC référence à la source
```

Règle d'or implémentée en données : `collected_fields` est validé contre `required_documents.field_schema`
côté serveur — la génération est **refusée** tant qu'un champ obligatoire est null. Pas de document à trous.

### 3.5 Audits

```
document_audits        id, document_id, document_version, type ('cible'),
                       status (en_cours | conforme | non_conforme),
                       findings jsonb,              -- écarts, suggestions, questions
                       created_at
global_audits          id, project_id, status, started_at, completed_at,
                       compliance_score numeric
audit_findings         id, global_audit_id, clause_id, document_id nullable,
                       verdict (conforme | nc_majeure | nc_mineure | opportunite),
                       explanation text,            -- explicabilité : clause + document + raison
                       recommendation text,
                       criticality int,
                       status (ouvert | corrige | reaudite)
```

`document_audits` = second audit systématique (§5.5) : déclenché à chaque dépôt/génération,
seul un audit `conforme` fait passer l'encart à `valide`.

### 3.6 Dossier final

```
dossier_exports        id, project_id, global_audit_id, storage_path,
                       correspondence_table jsonb,  -- exigence ↔ preuve
                       created_at
```

---

## 4. Format des référentiels (le contrat moteur ↔ référentiel)

Extrait de `referentiels/iso9001/documents.json` :

```json
{
  "key": "politique_qualite",
  "title": "Politique qualité",
  "clauses": ["5.2.1", "5.2.2"],
  "is_mandatory": true,
  "evidence_type": "document_redige",
  "generation_case": 1,
  "field_schema": {
    "raison_sociale":        { "type": "string",  "label": "Raison sociale", "required": true },
    "activites":             { "type": "text",    "label": "Activités et contexte", "required": true },
    "engagements_direction": { "type": "text",    "label": "Engagements de la direction", "required": true },
    "objectifs_qualite":     { "type": "array",   "label": "Objectifs qualité mesurables", "required": true, "minItems": 1 },
    "modalites_communication": { "type": "text",  "label": "Modalités de communication", "required": true }
  },
  "generation_template": "...",
  "validation_rules": {
    "requires_version": true,
    "requires_review_date": true,
    "requires_approval": true,
    "max_review_age_months": 12
  }
}
```

Le moteur ne connaît **aucune** norme : il itère sur `required_documents` de la version épinglée.
Ajouter ISO 14001 = ajouter `referentiels/iso14001/` + `node scripts/seed-referentiel.mjs iso14001`.

---

## 5. Pipeline IA

### 5.1 Principes (hérités de Holbert)

- **Jamais un seul appel** pour les tâches d'audit : pipeline multi-étapes avec contexte isolé
  par clause, puis synthèse.
- **Rappel systématique du référentiel** dans chaque prompt : l'exigence exacte de la clause est
  injectée depuis la base, jamais depuis la mémoire du modèle.
- **Structured outputs** (`output_config.format` + JSON Schema) pour toutes les sorties machine :
  classification, verdicts d'audit, données extraites. Zéro parsing fragile.
- **Non-fabrication** : les prompts d'extraction (Cas 2) exigent une référence à la source pour
  chaque donnée ; toute donnée sans source est retournée dans un champ `missing[]`, jamais inventée.
- SDK : `@anthropic-ai/sdk` dans `api/_lib/claude.js` (JS pur). Streaming pour l'entretien
  (UX conversationnelle), batch/QStash pour l'audit global.

### 5.2 Modèles

| Tâche | Modèle | Justification |
|---|---|---|
| Classification documentaire | `claude-opus-4-8` | la fiabilité du classement est le cœur du produit ; volume faible (au dépôt) |
| Entretien guidé (Cas 1) | `claude-opus-4-8` | conversation longue, suivi strict du field_schema |
| Extraction (Cas 2) | `claude-opus-4-8` | lecture PDF native (document blocks), traçabilité source |
| Génération de document | `claude-opus-4-8` | qualité rédactionnelle du livrable |
| Audit ciblé / audit global | `claude-opus-4-8` + adaptive thinking | raisonnement de conformité clause par clause |

Paramètres : `thinking: {type: "adaptive"}` pour les audits, pas de `temperature` (supprimé sur
Opus 4.7+). Si le coût devient un sujet en production, la classification est la première candidate
à un passage sur un modèle plus léger — décision à prendre sur métriques réelles, pas a priori.

### 5.3 Flux par module

**Reconnaissance (dépôt d'un fichier)**
1. Upload → Supabase Storage → ligne `documents`.
2. `api/documents/classify.js` : PDF passé en document block à Claude + liste des
   `required_documents` non pourvus du projet → sortie structurée
   `{ matched_key, confidence, formal_checks: {version, review_date, approval} }`.
3. `confidence ≥ 0.85` → rattachement automatique + second audit. En dessous → encart
   « Ce document semble être votre … — confirmez-vous ? » (`classification_confirmed_by`).

**Entretien guidé (Cas 1)**
1. `generation_sessions` créée avec le `field_schema` du référentiel.
2. Chaque tour : Claude reçoit le schéma + `collected_fields` courant → pose la prochaine
   question OU renvoie `{field, value}` à enregistrer (tool use).
3. Côté serveur : tant que `required` non satisfaits → la génération est bloquée et l'IA
   liste ce qui manque. Validation par code, pas par confiance dans le modèle.
4. Génération du projet de document → revue utilisateur → second audit.

**Extraction (Cas 2)**
1. L'utilisateur dépose les documents sources (`extraction_sources`).
2. Extraction structurée : chaque donnée sort avec `{value, source_document_id, source_excerpt}`.
3. UI de confirmation : l'utilisateur voit donnée + extrait source, confirme ou complète.
4. Données manquantes → demandées explicitement (encart), jamais inventées.

**Second audit (systématique)**
- Déclenché par QStash à chaque passage en `fourni`.
- Prompt : document + clauses liées + `validation_rules` → verdict structuré
  `{conforme: bool, ecarts: [], suggestions: [], questions: []}`.
- Boucle jusqu'à `conforme` → statut `valide`.

**Audit global**
- Job QStash : une passe **par clause** (contexte isolé : exigence + preuves rattachées),
  puis une passe de cohérence inter-documents (contradictions), puis synthèse + score.
- Chaque `audit_findings` porte clause + document + explication : l'explicabilité est
  une contrainte de schéma, pas une consigne de prompt.

---

## 6. Sécurité et conformité

- RLS activée sur toutes les tables dès la première migration — **pas de dette « RLS désactivée
  temporairement »** (leçon Holbert).
- Storage : bucket privé, chemin `{organization_id}/{project_id}/...`, policies alignées sur la RLS.
- Aucun contenu client dans les logs Vercel (les dossiers contiennent secrets industriels, données RH).
- RGPD : suppression en cascade organisation → projets → documents → storage.
- Discours produit : « préparez et fiabilisez votre dossier », jamais « obtenez votre certification ».
  Mention systématique dans l'UI d'export et les CGU.
- Tout texte utilisateur final au vouvoiement.

---

## 7. Export du dossier final

- `api/dossier/export.js` (job QStash) : assemble les documents `valide` dans l'ordre des
  chapitres de la norme.
- Génère : sommaire, table de correspondance exigence ↔ preuve (depuis `clause_documents` +
  `document_requirements`), contrôle final de complétude.
- Format MVP : **archive ZIP structurée** (dossiers par chapitre + `correspondance.pdf` +
  `sommaire.pdf`). Le PDF unique indexé viendra en phase 2 (assemblage PDF lourd en serverless).

---

## 8. Phasage de développement

**Phase 1 — Socle (MVP ISO 9001)**
1. Scaffold repo + Supabase (migrations socle multi-tenant + référentiels + projets).
2. Référentiel ISO 9001 : rédaction de `referentiels/iso9001/` (clauses + ~15 documents-clés
   avec triage et field_schemas) + script de seed.
3. Auth + création d'organisation + création de projet + checklist d'encarts.
4. Upload + classification + validation humaine.
5. Génération Cas 1 (entretien) sur 2 documents pilotes : politique qualité + fiche de fonction.
6. Second audit ciblé.

**Phase 2 — Boucle complète**
7. Génération Cas 2 (extraction) : revue de direction.
8. Audit global + recommandations + tableau de bord.
9. Export ZIP du dossier final.

**Phase 3 — Industrialisation**
10. Ajout ISO 27001 (validation du moteur générique), puis 14001/45001.
11. PDF indexé, connecteurs Drive/SharePoint, multi-utilisateurs avancé, relances.

---

*Document de travail — à valider avant scaffold. Les choix structurants sont : référentiels JSON
versionnés + seedés en base, `document_requirements` comme table pivot des encarts, validation des
champs obligatoires par code serveur, audits en jobs QStash avec sorties structurées.*
