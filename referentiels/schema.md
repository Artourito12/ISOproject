# Format des référentiels

Chaque norme vit dans un dossier `referentiels/<code>/` contenant trois fichiers JSON.
Ces fichiers sont la **source de vérité** versionnée dans git ; ils sont chargés en base
par `node scripts/seed-referentiel.mjs <code>` et l'application ne lit **que** la base.

## meta.json

```json
{
  "code": "iso9001",
  "name": "ISO 9001 — Systèmes de management de la qualité",
  "description": "…",
  "edition": "2015",
  "referential_version": "1.0.0"
}
```

- `edition` : édition officielle de la norme (ex. 2015).
- `referential_version` : semver de NOTRE référentiel. Toute modification de contenu
  publiée doit incrémenter cette version — les projets clients sont épinglés sur une
  `standard_version`, une mise à jour ne casse jamais un dossier en cours.

## clauses.json

Liste plate ; la hiérarchie est déduite du `number` (préfixe = parent).

```json
[
  { "number": "5", "title": "Leadership", "requirement": null },
  { "number": "5.2", "title": "Politique", "requirement": "Énoncé synthétique reformulé…" }
]
```

⚠️ `requirement` est un **énoncé synthétique reformulé** de l'exigence — le texte
officiel des normes ISO est protégé par le droit d'auteur et ne doit jamais être
reproduit tel quel.

## documents.json

Un objet par document/preuve attendu :

| Champ | Description |
|---|---|
| `key` | identifiant stable (snake_case) |
| `title`, `description` | affichés dans l'encart |
| `clauses` | numéros de clauses couvertes (rattachement N:N) |
| `is_mandatory` | obligatoire vs recommandé |
| `evidence_type` | `document_redige` \| `enregistrement` \| `preuve_externe` |
| `generation_case` | `1` entretien guidé · `2` extraction de sources · `3` non automatisable |
| `field_schema` | Cas 1 : champs obligatoires de l'entretien (le serveur bloque la génération tant qu'un champ `required` manque) |
| `source_hints` | Cas 2 : types de documents sources à demander |
| `generation_template` | Cas 1 & 2 : consignes de structure pour la génération |
| `validation_rules` | contrôles formels : `requires_version`, `requires_review_date`, `requires_approval`, `max_review_age_months` |

### field_schema

```json
{
  "nom_champ": {
    "type": "string | text | array | number | boolean",
    "label": "Question affichée à l'utilisateur",
    "required": true,
    "minItems": 1
  }
}
```
