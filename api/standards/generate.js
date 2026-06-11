// Génération d'un référentiel de norme à la demande (barre de recherche client).
// Pipeline : identification de la norme → recherche web approfondie →
// structuration en référentiel (clauses + documents + schémas) → insertion publiée.
// Les référentiels générés portent origin='ai' et validated_at=null :
// disponibles immédiatement, validés a posteriori par un super admin.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { anthropic, MODEL, callStructured } from "../_lib/claude.js";
import { insertReferentiel } from "../_lib/referentiel.js";

export const config = { maxDuration: 800 };

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    recognized: { type: "boolean", description: "la demande correspond-elle à une norme identifiable ?" },
    certifiable: {
      type: "boolean",
      description: "est-ce une norme de système de management (ou exigences certifiables) pour laquelle un dossier de certification se prépare ?",
    },
    code: { type: "string", description: "code court en minuscules sans espaces, ex: iso13485, iso22000, iso50001" },
    name: { type: "string", description: "nom complet, ex: ISO 13485 — Dispositifs médicaux" },
    edition: { type: "string", description: "édition en vigueur la plus probable, ex: 2016" },
    description: { type: "string", description: "description en une phrase, en français, vouvoiement" },
    reason: { type: "string", description: "si non reconnue ou non certifiable : explication courte pour l'utilisateur" },
  },
  required: ["recognized", "certifiable", "code", "name", "edition", "description", "reason"],
  additionalProperties: false,
};

const REFERENTIEL_SCHEMA = {
  type: "object",
  properties: {
    edition: { type: "string" },
    clauses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "string", description: "numéro hiérarchique, ex: 4, 4.1, 7.5" },
          title: { type: "string" },
          requirement: {
            type: ["string", "null"],
            description: "énoncé synthétique REFORMULÉ de l'exigence (jamais le texte officiel), null pour les chapitres",
          },
        },
        required: ["number", "title", "requirement"],
        additionalProperties: false,
      },
    },
    documents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "identifiant snake_case stable" },
          title: { type: "string" },
          description: { type: "string", description: "ce qui est attendu, en français, vouvoiement" },
          clauses: { type: "array", items: { type: "string" }, description: "numéros des clauses couvertes" },
          is_mandatory: { type: "boolean" },
          evidence_type: { type: "string", enum: ["document_redige", "enregistrement", "preuve_externe"] },
          generation_case: {
            type: "integer",
            enum: [1, 2, 3],
            description: "1=création par entretien guidé, 2=création par extraction de documents sources, 3=non automatisable (trace d'activité réelle ou document de tiers)",
          },
          fields: {
            type: ["array", "null"],
            description: "OBLIGATOIRE si generation_case=1 : champs à collecter pendant l'entretien",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "snake_case" },
                type: { type: "string", enum: ["string", "text", "array", "number", "boolean"] },
                label: { type: "string", description: "question/label en français, vouvoiement, avec exemples si utile" },
                required: { type: "boolean" },
                minItems: { type: ["integer", "null"] },
              },
              required: ["name", "type", "label", "required", "minItems"],
              additionalProperties: false,
            },
          },
          source_hints: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "si generation_case=2 : types de documents sources à demander",
          },
          generation_template: {
            type: ["string", "null"],
            description: "si generation_case=1 ou 2 : consignes de structure du document à générer",
          },
          validation_rules: {
            type: "object",
            properties: {
              requires_version: { type: ["boolean", "null"] },
              requires_review_date: { type: ["boolean", "null"] },
              requires_approval: { type: ["boolean", "null"] },
              max_review_age_months: { type: ["integer", "null"] },
            },
            required: ["requires_version", "requires_review_date", "requires_approval", "max_review_age_months"],
            additionalProperties: false,
          },
        },
        required: [
          "key", "title", "description", "clauses", "is_mandatory", "evidence_type",
          "generation_case", "fields", "source_hints", "generation_template", "validation_rules",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["edition", "clauses", "documents"],
  additionalProperties: false,
};

async function researchStandard(name, edition) {
  // Recherche web approfondie avec l'outil serveur web_search.
  // Boucle pause_turn : les outils serveur peuvent suspendre le tour.
  let messages = [
    {
      role: "user",
      content:
        `Recherchez tout ce qui est nécessaire pour préparer un dossier de certification ${name} (édition ${edition}).\n` +
        `Je veux des notes de travail détaillées et fiables couvrant :\n` +
        `1. La structure exacte des chapitres et clauses de la norme (numéros et intitulés), et pour chaque clause le sens de l'exigence.\n` +
        `2. La liste des informations documentées obligatoires (documents et enregistrements exigés explicitement).\n` +
        `3. Les documents et preuves habituellement attendus par les auditeurs de certification, au-delà du strict obligatoire.\n` +
        `4. Les spécificités sectorielles ou réglementaires françaises pertinentes le cas échéant.\n` +
        `Vérifiez l'édition en vigueur. Reformulez toujours les exigences (le texte officiel est protégé par le droit d'auteur).`,
    },
  ];

  let response;
  for (let i = 0; i < 6; i++) {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system:
        "Vous êtes un expert en certification ISO. Vous produisez des notes de recherche précises, structurées et sourcées, en français.",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      messages,
    });
    if (response.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: response.content }];
  }
  if (response.stop_reason === "refusal") throw new Error("recherche refusée");

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { query } = req.body || {};
  if (!query || String(query).trim().length < 3) {
    return res.status(400).json({ error: "Précisez la norme recherchée (ex. ISO 13485)" });
  }

  // --- Étape 1 : identification ---
  let id;
  try {
    id = await callStructured({
      system:
        "Vous identifiez des normes (ISO ou équivalents certifiables) à partir d'une demande libre d'utilisateur. " +
        "Soyez strict : si la demande ne correspond pas à une norme identifiable ou ne donne pas lieu à une préparation " +
        "de dossier de certification/conformité documentaire, répondez recognized=false ou certifiable=false avec une explication.",
      messages: [{ role: "user", content: `Demande de l'utilisateur : « ${String(query).trim()} »` }],
      schema: IDENTIFY_SCHEMA,
      maxTokens: 1000,
    });
  } catch (err) {
    return res.status(502).json({ error: `Identification impossible : ${err.message}` });
  }

  if (!id.recognized || !id.certifiable) {
    return res.status(422).json({ error: id.reason || "Cette demande ne correspond pas à une norme certifiable." });
  }

  // --- Déjà au catalogue ? ---
  const { data: existing } = await supabaseAdmin
    .from("standards")
    .select("id, code, name, standard_versions(id, is_current)")
    .eq("code", id.code)
    .maybeSingle();
  if (existing?.standard_versions?.some((v) => v.is_current)) {
    return res.status(200).json({ existing: true, code: existing.code, name: existing.name });
  }

  // --- Trace de la demande ---
  const { data: request } = await supabaseAdmin
    .from("standard_requests")
    .insert({
      organization_id: profile.organization_id,
      requested_by: profile.id,
      query: String(query).trim(),
    })
    .select()
    .single();

  async function failRequest(message) {
    if (request) {
      await supabaseAdmin
        .from("standard_requests")
        .update({ status: "erreur", error_message: message })
        .eq("id", request.id);
    }
    return res.status(502).json({ error: message });
  }

  try {
    // --- Étape 2 : recherche web approfondie ---
    const notes = await researchStandard(id.name, id.edition);

    // --- Étape 3 : structuration en référentiel ---
    const referentiel = await callStructured({
      system:
        "Vous transformez des notes de recherche sur une norme en référentiel structuré pour une plateforme de " +
        "préparation à la certification. Règles impératives :\n" +
        "- Énoncés d'exigences toujours REFORMULÉS (jamais le texte officiel, protégé par le droit d'auteur).\n" +
        "- Couvrez TOUTES les clauses d'exigences de la norme (généralement chapitres 4 à 10 pour les systèmes de management).\n" +
        "- 10 à 18 documents requis, couvrant au minimum toutes les informations documentées obligatoires.\n" +
        "- Triage rigoureux : generation_case=1 (l'IA peut créer le document via un entretien : politiques, procédures, " +
        "analyses) avec un schéma de champs complet et exigeant ; generation_case=2 (création par extraction de documents " +
        "sources : revues, synthèses, registres compilés) avec source_hints ; generation_case=3 (traces d'activités réelles, " +
        "enregistrements, certificats de tiers : JAMAIS générables).\n" +
        "- Tous les textes destinés à l'utilisateur final sont en français et au vouvoiement.\n" +
        "- Les clauses référencées par les documents doivent exister dans la liste des clauses.",
      messages: [
        {
          role: "user",
          content:
            `Norme : ${id.name} (édition ${id.edition})\n\n` +
            `Notes de recherche :\n${notes}\n\n` +
            `Produisez le référentiel complet (clauses + documents requis).`,
        },
      ],
      schema: REFERENTIEL_SCHEMA,
      thinking: true,
      maxTokens: 32000,
    });

    // Conversion fields[] -> field_schema{} (objet attendu par le moteur)
    const documents = referentiel.documents.map((d) => {
      const fieldSchema = {};
      for (const f of d.fields || []) {
        fieldSchema[f.name] = {
          type: f.type,
          label: f.label,
          required: f.required,
          ...(f.minItems ? { minItems: f.minItems } : {}),
        };
      }
      return {
        key: d.key,
        title: d.title,
        description: d.description,
        clauses: d.clauses,
        is_mandatory: d.is_mandatory,
        evidence_type: d.evidence_type,
        generation_case: d.generation_case,
        field_schema: d.generation_case === 1 ? fieldSchema : null,
        source_hints: d.generation_case === 2 ? d.source_hints : null,
        generation_template: d.generation_case !== 3 ? d.generation_template : null,
        validation_rules: Object.fromEntries(
          Object.entries(d.validation_rules || {}).filter(([, v]) => v !== null)
        ),
      };
    });

    // Garde-fou : un document Cas 1 sans champs obligatoires est invalide
    for (const d of documents) {
      if (d.generation_case === 1 && Object.keys(d.field_schema || {}).length === 0) {
        d.generation_case = 3;
        d.field_schema = null;
        d.generation_template = null;
      }
    }

    // --- Étape 4 : insertion (publiée immédiatement, validation expert a posteriori) ---
    const { standard } = await insertReferentiel({
      meta: {
        code: id.code,
        name: id.name,
        description: id.description,
        edition: referentiel.edition || id.edition,
        referential_version: "1.0.0",
      },
      clauses: referentiel.clauses,
      documents,
      origin: "ai",
    });

    await supabaseAdmin
      .from("standard_requests")
      .update({ status: "traitee", standard_id: standard.id })
      .eq("id", request.id);

    return res.status(200).json({
      existing: false,
      code: id.code,
      name: id.name,
      edition: referentiel.edition || id.edition,
      clausesCount: referentiel.clauses.length,
      documentsCount: documents.length,
      autoGenerated: true,
    });
  } catch (err) {
    return failRequest(`La préparation du référentiel a échoué : ${err.message}`);
  }
}
