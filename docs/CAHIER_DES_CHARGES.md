# Cahier des charges fonctionnel
## Plateforme SaaS d'audit, de génération documentaire et de constitution de dossiers ISO

---

## 1. Vision produit

Une plateforme en ligne sur laquelle une entreprise prépare sa certification ISO de bout en bout :

1. elle sélectionne la ou les normes visées ;
2. la plateforme lui indique précisément les documents requis ;
3. l'entreprise dépose les documents qu'elle possède ; l'IA les reconnaît et les classe automatiquement ;
4. pour les documents manquants, l'IA aide à les **créer** lorsque c'est possible, via un entretien guidé qui collecte toutes les informations nécessaires ;
5. une fois le dossier complet, l'IA réalise un **audit de conformité approfondi** et émet des recommandations ;
6. après correction des écarts, la plateforme **constitue le dossier final** structuré, prêt à transmettre à l'organisme certificateur.

**Positionnement clé :** la plateforme ne délivre pas la certification (réservée aux organismes accrédités). Elle prépare, fiabilise et maximise les chances de certification. C'est un outil de pré-audit, d'audit interne et de constitution de dossier.

**Principe directeur :** la fiabilité des données prime sur l'automatisation. L'IA ne fabrique jamais une preuve de conformité ; quand une donnée réelle est nécessaire, elle la demande.

---

## 2. Parcours utilisateur

| Étape | Action utilisateur | Action de la plateforme |
|---|---|---|
| 1. Sélection | Choisit la/les norme(s) | Génère une checklist dynamique des documents requis |
| 2. Dépôt | Glisse-dépose ses fichiers (ou connecte Drive/SharePoint) | Reconnaît, classe, rattache chaque document à une exigence |
| 3. Complétion | Consulte les encarts des éléments manquants | Affiche un encart par document/information à fournir, avec dépôt direct ou création assistée |
| 4. Génération | Dépose, saisit, ou lance la création IA dans chaque encart | Selon le cas : mène l'entretien (Cas 1) ou extrait des documents sources (Cas 2), génère, puis revérifie chaque document (second audit) |
| 5. Audit | Lance l'audit approfondi | Évalue la conformité clause par clause, produit un rapport |
| 6. Correction | Applique les recommandations | Réévalue, met à jour le score de conformité |
| 7. Constitution | Génère le dossier final | Assemble un dossier structuré exportable |

---

## 3. Architecture modulaire — le socle adaptable à toutes les normes

C'est le point technique structurant. Pour s'adapter à n'importe quelle norme ISO sans tout redévelopper, le **moteur** est séparé des **référentiels**.

### 3.1 Référentiel par norme (configuration)
Chaque norme est décrite dans un fichier de configuration structuré contenant, pour chaque clause :
- l'énoncé de l'exigence ;
- les documents obligatoires et recommandés associés ;
- le type de preuve attendu ;
- les critères et niveaux de conformité ;
- les règles de validation formelle (version, date de revue, approbation) ;
- pour les documents générables : le **schéma des champs obligatoires** et le **modèle** de génération.

### 3.2 Moteur générique
Le moteur lit le référentiel et applique la même logique quelle que soit la norme : reconnaissance, classement, génération assistée, audit, constitution. **Ajouter une norme = ajouter un référentiel, sans reprogrammer le moteur.**

### 3.3 Exemples de référentiels

| Norme | Documents-clés caractéristiques |
|---|---|
| ISO 9001 (qualité) | Politique qualité, manuel qualité, procédures, revue de direction, indicateurs |
| ISO 14001 (environnement) | Analyse environnementale, registre des aspects, veille réglementaire |
| ISO 27001 (sécurité de l'information) | Déclaration d'applicabilité (SoA), analyse de risques, politiques de sécurité |
| ISO 45001 (santé-sécurité au travail) | Évaluation des risques (DUERP), plan de prévention, plan d'actions |

---

## 4. Module de reconnaissance documentaire — cœur de la fiabilité

Quand un document est déposé, l'IA répond à : *« quel type de document est-ce, et à quelle exigence correspond-il ? »*

**Traitement :**
1. extraction du texte (OCR si document scanné) ;
2. classification sémantique par le contenu ;
3. rattachement à l'exigence normative correspondante ;
4. attribution d'un **score de confiance**.

**Garde-fou :** en dessous d'un seuil de confiance, l'IA demande une **validation humaine** (« Ce document semble être votre politique qualité — confirmez-vous ? »). Aucun classement incertain n'est validé silencieusement.

**Validation formelle :** vérification de la version à jour, de la date de revue, des signatures/approbations et de la cohérence des références croisées entre documents.

---

## 5. Module de génération assistée de documents

L'IA aide à constituer les documents manquants. Pour chaque document requis et absent, elle commence par un **triage automatique** : que peut-elle réellement faire ?

### 5.1 Triage — trois cas selon ce dont l'IA a besoin

**Cas 1 — Création directe à partir de quelques informations.**
L'IA peut produire le document en posant à l'utilisateur quelques questions ciblées ; elle mène alors un entretien guidé.
*Exemples : politique qualité, politique de sécurité de l'information, fiches de fonction, procédures simples, politique environnementale.*

**Cas 2 — Création par extraction de documents sources.**
L'IA peut produire le document, mais a besoin que l'utilisateur dépose des documents sources dont elle **extrait** les informations utiles pour assembler le document demandé.
*Exemples : revue de direction (à partir de comptes-rendus, exports d'indicateurs, plans d'actions), synthèses, tableaux de bord, cartographies à partir de données existantes.*

**Cas 3 — Non automatisable.**
L'IA ne peut pas créer le document : il est la trace d'une activité réelle ou émane d'un tiers. Elle se limite à vérifier sa présence et sa validité, et à expliquer ce qui est attendu.
*Exemples : enregistrements de mesures, certificats externes, preuves de réunions tenues, justificatifs.*

### 5.2 Les encarts — interface de complétion du dossier

Pour chaque élément à fournir (document manquant **ou** information manquante), la plateforme affiche un **encart** dédié décrivant précisément ce qui est attendu. Chaque encart propose, selon le cas :

- **Ajouter directement** : déposer le document ou saisir l'information demandée ;
- **Créer / compléter avec l'IA** : lancer la génération assistée — entretien guidé (Cas 1) ou dépôt de documents sources pour extraction (Cas 2).

Pour le Cas 3, l'encart n'autorise que le dépôt direct et rappelle ce qui est exigé.

Chaque encart affiche son **état** : *à fournir / en cours / fourni / validé*. L'utilisateur visualise en permanence ce qu'il reste à traiter pour compléter le dossier.

### 5.3 Déroulé de la création assistée

1. l'IA identifie le cas applicable ;
2. **Cas 1** — entretien structuré couvrant **tous** les champs obligatoires définis dans le référentiel ; l'IA ne génère pas tant qu'un champ manque ;
   **Cas 2** — l'IA demande les documents sources, en extrait les informations, **affiche ce qu'elle a extrait avec la source correspondante**, demande confirmation ou complément à l'utilisateur, puis génère ;
3. génération d'un projet de document soumis à validation de l'utilisateur.

### 5.4 Règle d'or — exhaustivité et non-fabrication

> L'IA ne génère jamais un document à trous et n'invente jamais de donnée de conformité.
> En Cas 1, elle poursuit l'entretien tant qu'une information obligatoire manque. En Cas 2, chaque élément du document est rattaché à sa source ; si une information requise est absente des documents fournis, l'IA la demande plutôt que de l'inventer.

### 5.5 Second audit systématique après chaque ajout ou création

Dès qu'un document est ajouté ou généré — **quel que soit le cas** — l'IA lance immédiatement une **vérification de conformité ciblée** sur ce document (distincte de l'audit global du §6, qui porte sur l'ensemble du dossier). Elle :

- contrôle la conformité du document au regard des clauses concernées ;
- signale les écarts, manques ou incohérences ;
- formule des **suggestions concrètes** d'amélioration ;
- **pose des questions** lorsqu'un point est ambigu ;
- recommence jusqu'à ce que le document soit conforme.

Seul un document ayant passé cette vérification passe à l'état **validé** et compte dans la complétion du dossier. Objectif : que chaque pièce soit irréprochable avant même l'audit global.

### 5.6 Exemple détaillé — DUERP (Cas 1)

Le DUERP (Document Unique d'Évaluation des Risques Professionnels) illustre pourquoi l'entretien complet est indispensable : aucune de ces informations ne peut être inventée.

**Informations collectées par l'entretien guidé :**
- identité et coordonnées de l'établissement, effectif total ;
- secteur(s) et nature des activités ;
- inventaire des **unités de travail** (postes, ateliers, services) ;
- pour chaque unité de travail :
  - équipements, machines et outils utilisés,
  - substances ou produits manipulés,
  - **dangers et risques identifiés**,
  - **cotation** de chaque risque (gravité × probabilité/fréquence),
  - mesures de prévention déjà en place ;
- **plan d'actions** de prévention (PAPRIPACT au-delà de 50 salariés) ;
- modalités et fréquence de mise à jour.

Tant que ces éléments ne sont pas tous renseignés, l'IA ne produit pas le DUERP : elle poursuit l'entretien et liste les informations encore attendues. Une fois généré, le document passe par le second audit (§5.5) avant d'être validé.

---

## 6. Module d'audit de conformité approfondi

Une fois le dossier complet, le moteur passe **chaque exigence** en revue.

- confrontation des preuves fournies aux attentes de chaque clause ;
- statut par exigence : **conforme / non-conformité majeure / non-conformité mineure / opportunité d'amélioration** ;
- analyse de la **cohérence** d'ensemble (contradictions entre documents) ;
- analyse de la **complétude** (couverture totale du référentiel) ;
- analyse de la **qualité de contenu** (la procédure décrit-elle réellement ce qu'exige la clause ?).

**Explicabilité obligatoire :** chaque constat cite la clause concernée, le document analysé et la raison de l'écart. Sans cette traçabilité, le rapport n'a aucune valeur d'audit.

---

## 7. Module de recommandations

Pour chaque écart, la plateforme génère une recommandation concrète :
- ce qui manque ou ne va pas ;
- pourquoi c'est exigé (clause de référence) ;
- l'action suggérée, ou un modèle de document à compléter (renvoi vers le module de génération).

Les recommandations sont **hiérarchisées par criticité** : les non-conformités bloquantes d'abord.

---

## 8. Module de constitution du dossier final

Assemblage automatique des documents validés dans une structure conforme aux attentes du certificateur :
- sommaire et classement par chapitre de la norme ;
- **table de correspondance** exigence ↔ preuve ;
- contrôle final de complétude ;
- export packagé (PDF indexé ou archive structurée), prêt à transmettre.

---

## 9. Tableau de bord et suivi

- taux de complétion du dossier ;
- score de conformité global et par chapitre ;
- liste des écarts restants ;
- suivi des actions correctives avec relances ;
- historique et versioning des documents.

---

## 10. Points critiques à anticiper

**Positionnement réglementaire.** La certification officielle ne peut être délivrée que par un organisme accrédité. Le discours commercial doit l'affirmer clairement (« préparez et fiabilisez votre dossier », et non « obtenez votre certification »), sous peine de risque juridique.

**Non-fabrication des données.** Principe non négociable : l'IA ne crée jamais de preuve de conformité fictive. Pour toute donnée réelle, elle la demande (cf. familles B et C, §5).

**Confidentialité et sécurité.** Les dossiers ISO contiennent des données très sensibles (sécurité, RH, secrets industriels). Hébergement sécurisé, chiffrement, conformité RGPD — et idéalement la conformité ISO 27001 de la plateforme elle-même comme argument commercial.

**Responsabilité.** Stipuler contractuellement que les recommandations sont une aide à la décision, sans garantie de certification, avec maintien de l'humain dans la boucle de validation.

**Maintenance des référentiels.** Les normes évoluent (révisions). Prévoir une mise à jour et un versioning des référentiels alignés sur les éditions officielles.

---

## 11. Phasage de développement suggéré

1. **MVP sur une seule norme** (ISO 9001, la plus répandue) : valider tout le pipeline de bout en bout — reconnaissance, génération guidée, audit, constitution.
2. **Fiabilisation** de la reconnaissance documentaire et de la génération (preuve de la valeur et de la confiance).
3. **Industrialisation du moteur générique** et ajout progressif des normes (14001, 27001, 45001…) par simple ajout de référentiels.
4. **Enrichissement** : connecteurs (Drive/SharePoint), collaboration multi-utilisateurs, suivi des échéances, intégrations.

---

*Document de travail — cahier des charges fonctionnel. À compléter par les spécifications techniques détaillées et le modèle économique.*
