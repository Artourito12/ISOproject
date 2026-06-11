// Entretien guidé (Cas 1) : l'IA collecte les champs obligatoires du référentiel
// en posant des questions. La complétude est validée PAR LE CODE (missingRequiredFields),
// jamais par la confiance dans le modèle — règle d'or de non-fabrication.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";
import { missingRequiredFields } from "../_lib/fields.js";

const START_MARKER = "__start__";

const TURN_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "Votre message à l'utilisateur : accusé de réception de ce qu'il vient de donner et prochaine question (vouvoiement). Si tout est collecté, dites-le et invitez à générer le document.",
    },
    recorded_fields: {
      type: "array",
      description: "Champs dont la valeur a pu être extraite de la dernière réponse de l'utilisateur",
      items: {
        type: "object",
        properties: {
          field: { type: "string", description: "nom exact du champ dans le schéma" },
          value: {
            type: "string",
            description: "valeur extraite ; si c'est une liste ou une structure, encodez-la en JSON",
          },
        },
        required: ["field", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "recorded_fields"],
  additionalProperties: false,
};

function parseValue(raw) {
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { requirementId, sessionId, message } = req.body || {};

  // --- Chargement ou création de la session ---
  let session;
  if (sessionId) {
    const { data } = await supabaseAdmin
      .from("generation_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();
    if (!data || data.organization_id !== profile.organization_id) {
      return res.status(404).json({ error: "Session introuvable" });
    }
    session = data;
  } else {
    if (!requirementId) return res.status(400).json({ error: "requirementId requis" });
    const { data: existing } = await supabaseAdmin
      .from("generation_sessions")
      .select("*")
      .eq("document_requirement_id", requirementId)
      .neq("status", "termine")
      .maybeSingle();
    session = existing;
  }

  // --- Encart + document requis (schéma des champs) ---
  const reqId = session?.document_requirement_id || requirementId;
  const { data: requirement } = await supabaseAdmin
    .from("document_requirements")
    .select(
      "id, project_id, organization_id, required_documents(key, title, description, generation_case, field_schema, generation_template)"
    )
    .eq("id", reqId)
    .single();

  if (!requirement || requirement.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Encart introuvable" });
  }
  const requiredDoc = requirement.required_documents;
  if (requiredDoc.generation_case !== 1) {
    return res.status(400).json({ error: "Ce document ne se crée pas par entretien guidé" });
  }
  const fieldSchema = requiredDoc.field_schema || {};

  if (!session) {
    const { data: created, error: createError } = await supabaseAdmin
      .from("generation_sessions")
      .insert({
        document_requirement_id: requirement.id,
        organization_id: profile.organization_id,
        generation_case: 1,
        status: "collecte",
        collected_fields: {},
        transcript: [{ role: "user", content: START_MARKER }],
      })
      .select()
      .single();
    if (createError) return res.status(500).json({ error: createError.message });
    session = created;
  }

  // --- Tour de conversation ---
  const transcript = Array.isArray(session.transcript) ? [...session.transcript] : [];
  const collected = session.collected_fields || {};

  if (message) transcript.push({ role: "user", content: String(message) });

  const missingBefore = missingRequiredFields(fieldSchema, collected);

  const system =
    `Vous menez un entretien guidé pour constituer le document « ${requiredDoc.title} » ` +
    `dans le cadre d'une préparation à la certification ISO.\n\n` +
    `Description du document attendu : ${requiredDoc.description}\n\n` +
    `Schéma des champs à collecter (JSON) :\n${JSON.stringify(fieldSchema, null, 2)}\n\n` +
    `Champs déjà collectés :\n${JSON.stringify(collected, null, 2)}\n\n` +
    `Champs obligatoires encore manquants : ${missingBefore.join(", ") || "aucun"}\n\n` +
    `Règles impératives :\n` +
    `- Vouvoyez toujours l'utilisateur.\n` +
    `- Extrayez dans recorded_fields toute valeur exploitable de sa dernière réponse (champ du schéma uniquement). N'inventez JAMAIS une valeur : seul ce que l'utilisateur a réellement dit peut être enregistré.\n` +
    `- Posez ensuite UNE question ciblée sur le champ manquant le plus important (vous pouvez regrouper 2 champs courts et liés). Reformulez le label en question naturelle, avec un exemple concret si utile.\n` +
    `- Pour les champs de type array, aidez l'utilisateur à structurer sa réponse élément par élément si besoin.\n` +
    `- Si l'utilisateur pose une question, répondez-y brièvement puis revenez à l'entretien.\n` +
    `- Quand tous les champs obligatoires sont collectés, dites-le clairement et invitez l'utilisateur à lancer la génération du document.`;

  const claudeMessages = transcript.map((t) => ({
    role: t.role,
    content: t.content === START_MARKER ? "Commençons l'entretien." : t.content,
  }));

  let turn;
  try {
    turn = await callStructured({
      system,
      messages: claudeMessages,
      schema: TURN_SCHEMA,
      maxTokens: 4000,
    });
  } catch (err) {
    return res.status(502).json({ error: `L'assistant est indisponible : ${err.message}` });
  }

  // --- Enregistrement des champs extraits (validés contre le schéma) ---
  for (const rec of turn.recorded_fields || []) {
    if (!Object.prototype.hasOwnProperty.call(fieldSchema, rec.field)) continue;
    collected[rec.field] = parseValue(rec.value);
  }

  transcript.push({ role: "assistant", content: turn.message });

  const missing = missingRequiredFields(fieldSchema, collected);

  const { error: saveError } = await supabaseAdmin
    .from("generation_sessions")
    .update({
      collected_fields: collected,
      transcript,
      status: "collecte",
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
  if (saveError) return res.status(500).json({ error: saveError.message });

  const requiredCount = Object.values(fieldSchema).filter((f) => f.required).length;

  return res.status(200).json({
    sessionId: session.id,
    message: turn.message,
    transcript: transcript.filter((t) => t.content !== START_MARKER),
    collectedFields: collected,
    missingFields: missing.map((name) => ({ name, label: fieldSchema[name]?.label || name })),
    progress: { collected: requiredCount - missing.length, total: requiredCount },
    readyToGenerate: missing.length === 0,
  });
}
