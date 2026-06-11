// Classification d'un document déposé : « quel type de document est-ce,
// et à quelle exigence correspond-il ? »
// Garde-fou : en dessous du seuil de confiance, le rattachement n'est PAS appliqué —
// l'encart passe en attente de confirmation humaine.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";

const CONFIDENCE_THRESHOLD = 0.85;

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    matched_key: {
      type: ["string", "null"],
      description: "key du document requis correspondant, ou null si aucun ne correspond",
    },
    confidence: { type: "number", description: "confiance entre 0 et 1" },
    reasoning: { type: "string", description: "justification courte du classement" },
    formal_checks: {
      type: "object",
      properties: {
        has_version: { type: "boolean" },
        has_review_date: { type: "boolean" },
        has_approval: { type: "boolean" },
        detected_date: { type: ["string", "null"] },
      },
      required: ["has_version", "has_review_date", "has_approval", "detected_date"],
      additionalProperties: false,
    },
  },
  required: ["matched_key", "confidence", "reasoning", "formal_checks"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { documentId } = req.body || {};
  if (!documentId) return res.status(400).json({ error: "documentId requis" });

  // Document + contrôle d'appartenance à l'organisation
  const { data: doc } = await supabaseAdmin
    .from("documents")
    .select("id, project_id, organization_id, title, storage_path, mime_type")
    .eq("id", documentId)
    .single();
  if (!doc || doc.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  // Encarts non pourvus du projet → liste des candidats au rattachement
  const { data: openRequirements } = await supabaseAdmin
    .from("document_requirements")
    .select("id, required_document_id, required_documents(key, title, description, evidence_type)")
    .eq("project_id", doc.project_id)
    .is("document_id", null);

  if (!openRequirements?.length) {
    return res.status(200).json({ matched: false, reason: "Aucun encart en attente sur ce projet" });
  }

  // Contenu du fichier (PDF passé en document block, lecture native par Claude)
  const { data: file, error: dlError } = await supabaseAdmin.storage
    .from("documents")
    .download(doc.storage_path);
  if (dlError) return res.status(500).json({ error: "Téléchargement du fichier impossible" });

  const buffer = Buffer.from(await file.arrayBuffer());
  const isPdf = doc.mime_type === "application/pdf";

  const candidates = openRequirements.map((r) => ({
    key: r.required_documents.key,
    title: r.required_documents.title,
    description: r.required_documents.description,
    evidence_type: r.required_documents.evidence_type,
  }));

  const content = [
    isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
        }
      : { type: "text", text: buffer.toString("utf8").slice(0, 100000) },
    {
      type: "text",
      text:
        `Voici la liste des documents attendus encore manquants dans ce dossier de certification :\n` +
        `${JSON.stringify(candidates, null, 2)}\n\n` +
        `Classez le document fourni : à quel document attendu correspond-il (matched_key), avec quelle confiance ? ` +
        `Si aucun ne correspond, matched_key = null. ` +
        `Relevez aussi les éléments formels : présence d'un numéro de version, d'une date de revue/mise à jour, d'une mention d'approbation ou signature.`,
    },
  ];

  const result = await callStructured({
    system:
      "Vous êtes un expert en systèmes de management ISO. Vous classez des documents déposés par une entreprise " +
      "en préparation de certification. Vous ne devinez jamais : si le contenu ne permet pas un classement sûr, " +
      "votre confiance doit être basse.",
    messages: [{ role: "user", content }],
    schema: CLASSIFICATION_SCHEMA,
  });

  if (!result.matched_key) {
    return res.status(200).json({ matched: false, result });
  }

  const requirement = openRequirements.find(
    (r) => r.required_documents.key === result.matched_key
  );
  if (!requirement) return res.status(200).json({ matched: false, result });

  const autoConfirmed = result.confidence >= CONFIDENCE_THRESHOLD;

  // Rattachement : automatique au-dessus du seuil, sinon en attente de confirmation
  // humaine (classification_confirmed_by reste null tant que personne n'a confirmé).
  // Le passage à 'valide' relève du second audit (api/audits/document.js, à venir).
  const { error: updateError } = await supabaseAdmin
    .from("document_requirements")
    .update({
      document_id: doc.id,
      status: autoConfirmed ? "fourni" : "en_cours",
      classification_confidence: result.confidence,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requirement.id);
  if (updateError) return res.status(500).json({ error: updateError.message });

  return res.status(200).json({
    matched: true,
    requirementId: requirement.id,
    matchedKey: result.matched_key,
    confidence: result.confidence,
    autoConfirmed,
    needsHumanConfirmation: !autoConfirmed,
    formalChecks: result.formal_checks,
    reasoning: result.reasoning,
  });
}
