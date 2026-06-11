// Génération de référentiel à la demande — ÉTAPE 3/3 : structuration + insertion.
// Sans thinking et avec un format resserré pour tenir dans la fenêtre d'exécution.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";
import { insertReferentiel } from "../_lib/referentiel.js";

export const config = { maxDuration: 800 };

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
            description: "énoncé synthétique REFORMULÉ de l'exigence (max 40 mots, jamais le texte officiel), null pour les chapitres",
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
          description: { type: "string", description: "ce qui est attendu, en français, vouvoiement, 1-2 phrases" },
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
            description: "OBLIGATOIRE si generation_case=1 : champs à collecter pendant l'entretien (4 à 7 champs)",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "snake_case" },
                type: { type: "string", enum: ["string", "text", "array", "number", "boolean"] },
                label: { type: "string", description: "question/label en français, vouvoiement" },
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
            description: "si generation_case=1 ou 2 : consignes de structure (1-2 phrases)",
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

async function loadText(path) {
  const { data } = await supabaseAdmin.storage.from("documents").download(path);
  if (!data) return null;
  return data.text();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId requis" });

  const { data: request } = await supabaseAdmin
    .from("standard_requests")
    .select("id, organization_id, status, standard_id, standards(code, name)")
    .eq("id", requestId)
    .single();
  if (!request || request.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Demande introuvable" });
  }

  // Idempotence : déjà construite ?
  if (request.status === "traitee" && request.standards) {
    return res.status(200).json({
      existing: false,
      code: request.standards.code,
      name: request.standards.name,
      cached: true,
    });
  }

  const base = `_system/standard_requests/${requestId}`;
  const identityRaw = await loadText(`${base}/identity.json`);
  const notes = await loadText(`${base}/notes.txt`);
  if (!identityRaw || !notes) {
    return res.status(400).json({ error: "Les étapes précédentes ne sont pas terminées" });
  }
  const id = JSON.parse(identityRaw);

  try {
    const referentiel = await callStructured({
      system:
        "Vous transformez des notes de recherche sur une norme en référentiel structuré pour une plateforme de " +
        "préparation à la certification. Règles impératives :\n" +
        "- Énoncés d'exigences toujours REFORMULÉS et CONCIS (max 40 mots ; jamais le texte officiel, protégé par le droit d'auteur).\n" +
        "- Couvrez TOUTES les clauses d'exigences de la norme (généralement chapitres 4 à 10), sans sous-découper au-delà de 2 niveaux (ex. 7.5, pas 7.5.3.2).\n" +
        "- 10 à 14 documents requis, couvrant en priorité les informations documentées obligatoires.\n" +
        "- Triage rigoureux : generation_case=1 (créable par entretien : politiques, procédures, analyses) avec 4 à 7 champs ; " +
        "generation_case=2 (créable par extraction de documents sources) avec source_hints ; generation_case=3 (traces " +
        "d'activités réelles, enregistrements, certificats de tiers : JAMAIS générables).\n" +
        "- Tous les textes destinés à l'utilisateur final sont en français et au vouvoiement.\n" +
        "- Les clauses référencées par les documents doivent exister dans la liste des clauses.\n" +
        "- Soyez direct et efficace : produisez le JSON sans délibération superflue.",
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
      maxTokens: 24000,
    });

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
      const doc = {
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
      // Garde-fou : un document Cas 1 sans champs obligatoires devient Cas 3
      if (doc.generation_case === 1 && Object.keys(doc.field_schema || {}).length === 0) {
        doc.generation_case = 3;
        doc.field_schema = null;
        doc.generation_template = null;
      }
      return doc;
    });

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
      .eq("id", requestId);

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
    await supabaseAdmin
      .from("standard_requests")
      .update({ status: "erreur", error_message: `Construction : ${err.message}` })
      .eq("id", requestId);
    return res.status(502).json({ error: `La construction du référentiel a échoué : ${err.message}` });
  }
}
