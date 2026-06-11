# ISOproject

Plateforme SaaS de préparation à la certification ISO : checklist documentaire par norme,
reconnaissance et classement IA des documents, génération assistée, audit de conformité,
constitution du dossier final.

- Vision produit : `docs/CAHIER_DES_CHARGES.md`
- Architecture : `docs/SPECS_TECHNIQUES.md`
- Format des référentiels de normes : `referentiels/schema.md`

## Mise en route

1. **Créer un projet Supabase dédié** (ne pas réutiliser ceux de Heldert/Holbert).
2. **Appliquer la migration** : contenu de `supabase/migrations/20260611000000_initial_schema.sql`
   dans le SQL Editor de Supabase (ou `supabase db push` si la CLI est liée au projet).
3. **Configurer l'environnement** : copier `.env.example` vers `.env` et renseigner les clés
   (URL + anon key + service role key Supabase, clé Anthropic).
4. **Installer et seeder** :
   ```sh
   npm install
   npm run seed iso9001
   ```
5. **Lancer en local** :
   ```sh
   npm run dev          # frontend seul (Vite)
   vercel dev           # frontend + fonctions api/* (recommandé)
   ```

## Vérification avant push

```sh
npx tsc -b   # même vérification que le build Vercel (catch les imports inutilisés)
```

## Conventions

- `api/*.js` : **JavaScript pur**, aucune syntaxe TypeScript (sinon FUNCTION_INVOCATION_FAILED sur Vercel).
- Tout texte visible par l'utilisateur final : **vouvoiement**.
- Pas de hardcode métier : le moteur lit les référentiels **en base** (seedés depuis `referentiels/`).
- Les versions de référentiel publiées sont **immuables** : toute modification de contenu passe par
  un incrément de `referential_version` dans `meta.json` + re-seed.
- RLS activée sur toutes les tables : les écritures sensibles (audits, organisations, exports)
  passent exclusivement par les fonctions `api/*` en service role.
- Positionnement produit : « préparez et fiabilisez votre dossier », jamais « obtenez votre
  certification » (réservée aux organismes accrédités).
