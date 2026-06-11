// Second audit systématique (cahier des charges §5.5) : vérification de
// conformité ciblée d'UN document au regard des clauses qu'il couvre.
// Seul un verdict conforme fait passer l'encart à l'état "valide".
// Les règles formelles (version, date de revue, approbation) sont
// re-vérifiées PAR LE CODE après le verdict du modèle.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";

export const config = { maxDuration: 300 };

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    conforme: {
      type: "boolean",
      description: "true uniquement si le document répond aux exigences des clauses ET aux règles formelles",
    },
    ecarts: {
      type: "array",
      description: "écarts de conformité constatés (vide si conforme)",
      items: {
        type: "object",
        properties: {
          titre: { type: "string", description: "intitulé court de l'écart" },
          description: { type: "string", description: "explication : ce qui manque ou ne va pas, et pourquoi c'est exigé" },
          clause: { type: ["string", "null"], description: "numéro de la clause concernée, null si écart formel" },
        },
        required: ["titre", "description", "clause"],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "suggestions concrètes d'amélioration, formulées au vouvoiement",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "questions à poser à l'utilisateur lorsqu'un point est ambigu, au vouvoiement",
    },
    formal_checks: {
      type: "object",
      properties: {
        has_version: { type: "boolean", description: "le document porte un numéro de version identifiable" },
        has_review_date: { type: "boolean", description: "le document porte une date de revue/mise à jour" },
        has_approval: { type: "boolean", description: "le document porte une approbation, signature ou validation nominative" },
      },
      required: ["has_version", "has_review_date", "has_approval"],
      additionalProperties: false,
    },
  },
  required: ["conforme", "ecarts", "suggestions", "questions", "formal_checks"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { requirementId } = req.body || {};
  if (!requirementId) return res.status(400).json({ error: "requirementId requis" });

  // Encart + document + référentiel
  const { data: requirement } = await supabaseAdmin
    .from("document_requirements")
    .select(
      "id, organization_id, document_id, required_document_id, " +
        "required_documents(key, title, description, evidence_type, validation_rules), " +
        "documents(id, title, storage_path, mime_type, current_version)"
    )
    .eq("id", requirementId)
    .single();

  if (!requirement || requirement.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Encart introuvable" });
  }
  if (!requirement.document_id || !requirement.documents) {
    return res.status(400).json({ error: "Aucun document n'est rattaché à cet encart" });
  }
  const doc = requirement.documents;
  const requiredDoc = requirement.required_documents;
  const rules = requiredDoc.validation_rules || {};

  // Exigences des clauses couvertes (depuis la base, jamais de mémoire)
  const { data: clauseLinks } = await supabaseAdmin
    .from("clause_documents")
    .select("clauses(number, title, requirement_text)")
    .eq("required_document_id", requirement.required_document_id);
  const clauses = (clauseLinks || [])
    .map((l) => l.clauses)
    .filter((c) => c?.requirement_text)
    .map((c) => `- Clause ${c.number} (${c.title}) : ${c.requirement_text}`)
    .join("\n");

  // Contenu du document
  const { data: file, error: dlError } = await supabaseAdmin.storage
    .from("documents")
    .download(doc.storage_path);
  if (dlError) return res.status(500).json({ error: "Téléchargement du document impossible" });
  const buffer = Buffer.from(await file.arrayBuffer());
  const isPdf = doc.mime_type === "application/pdf";

  const content = [
    isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
        }
      : { type: "text", text: `Contenu du document :\n\n${buffer.toString("utf8").slice(0, 150000)}` },
    {
      type: "text",
      text:
        `Document audité : « ${doc.title} », fourni au titre de l'exigence « ${requiredDoc.title} ».\n\n` +
        `Ce qui est attendu : ${requiredDoc.description}\n\n` +
        `Exigences normatives couvertes :\n${clauses || "(non précisées)"}\n\n` +
        `Règles formelles applicables : ${JSON.stringify(rules)}\n\n` +
        `Réalisez l'audit de conformité ciblé de ce document.`,
    },
  ];

  let verdict;
  try {
    verdict = await callStructured({
      system:
        "Vous êtes un auditeur expert en systèmes de management ISO. Vous auditez UN document au regard des clauses " +
        "qu'il doit couvrir. Règles :\n" +
        "- Soyez exigeant mais juste : un document est conforme s'il répond réellement au fond des exigences, pas " +
        "seulement s'il en reprend les mots.\n" +
        "- Chaque écart doit citer la clause concernée et expliquer la raison (explicabilité obligatoire).\n" +
        "- Distinguez les écarts bloquants (ecarts) des améliorations souhaitables (suggestions).\n" +
        "- Si un point est ambigu plutôt que manquant, posez une question au lieu de créer un écart.\n" +
        "- Vérifiez les éléments formels : numéro de version, date de revue, trace d'approbation.\n" +
        "- Tous les textes sont en français, au vouvoiement.",
      messages: [{ role: "user", content }],
      schema: AUDIT_SCHEMA,
      thinking: true,
      maxTokens: 8000,
    });
  } catch (err) {
    return res.status(502).json({ error: `L'audit est indisponible : ${err.message}` });
  }

  // Règles formelles re-vérifiées par le code : un manquement formel est un écart, point.
  const formalGaps = [];
  if (rules.requires_version && !verdict.formal_checks.has_version) {
    formalGaps.push({
      titre: "Numéro de version manquant",
      description: "Le référentiel exige que ce document porte un numéro de version identifiable.",
      clause: null,
    });
  }
  if (rules.requires_review_date && !verdict.formal_checks.has_review_date) {
    formalGaps.push({
      titre: "Date de revue manquante",
      description: "Le référentiel exige que ce document porte une date de revue ou de mise à jour.",
      clause: null,
    });
  }
  if (rules.requires_approval && !verdict.formal_checks.has_approval) {
    formalGaps.push({
      titre: "Approbation manquante",
      description: "Le référentiel exige une trace d'approbation (signature, validation nominative).",
      clause: null,
    });
  }

  const existingTitles = new Set(verdict.ecarts.map((e) => e.titre));
  for (const gap of formalGaps) {
    if (!existingTitles.has(gap.titre)) verdict.ecarts.push(gap);
  }
  const conforme = verdict.conforme && verdict.ecarts.length === 0;

  const findings = {
    conforme,
    ecarts: verdict.ecarts,
    suggestions: verdict.suggestions,
    questions: verdict.questions,
    formal_checks: verdict.formal_checks,
  };

  // Enregistrement de l'audit + transition d'état
  const { error: auditError } = await supabaseAdmin.from("document_audits").insert({
    document_id: doc.id,
    organization_id: profile.organization_id,
    document_version: doc.current_version,
    status: conforme ? "conforme" : "non_conforme",
    findings,
  });
  if (auditError) return res.status(500).json({ error: auditError.message });

  await supabaseAdmin
    .from("document_requirements")
    .update({
      status: conforme ? "valide" : "fourni",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requirement.id);

  return res.status(200).json({ conforme, findings });
}
