// Génération du document après collecte (Cas 1 : entretien ; Cas 2 : extraction).
// Règle d'or appliquée PAR LE CODE : refus si un champ obligatoire manque (Cas 1)
// ou si une information manquante identifiée n'a pas reçu de réponse (Cas 2).
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { anthropic, MODEL } from "../_lib/claude.js";
import { missingRequiredFields } from "../_lib/fields.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId requis" });

  const { data: session } = await supabaseAdmin
    .from("generation_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (!session || session.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  const { data: requirement } = await supabaseAdmin
    .from("document_requirements")
    .select(
      "id, project_id, organization_id, required_document_id, required_documents(key, title, description, field_schema, generation_template, validation_rules)"
    )
    .eq("id", session.document_requirement_id)
    .single();
  if (!requirement) return res.status(404).json({ error: "Encart introuvable" });
  const requiredDoc = requirement.required_documents;

  // --- Règle d'or : aucun document à trous ---
  let sourceData; // ce qui sera fourni au modèle comme seule source autorisée
  if (session.generation_case === 2) {
    // Cas 2 : chaque manque identifié à l'extraction doit avoir reçu une réponse
    const missingTopics = session.collected_fields?.missing || [];
    const responses = session.collected_fields?.responses || {};
    const unanswered = missingTopics.filter((m) => !String(responses[m.topic] || "").trim());
    if (unanswered.length > 0) {
      return res.status(400).json({
        error: "Des informations manquantes n'ont pas encore de réponse : la génération est bloquée.",
        missing: unanswered.map((m) => m.topic),
      });
    }

    const { data: sources } = await supabaseAdmin
      .from("extraction_sources")
      .select("extracted_data, documents(title)")
      .eq("generation_session_id", session.id);
    if (!sources || sources.length === 0) {
      return res.status(400).json({ error: "Aucune donnée extraite : lancez d'abord l'extraction." });
    }

    sourceData =
      `Données extraites des documents sources (chaque donnée cite son document d'origine) :\n` +
      sources
        .flatMap((s) =>
          (s.extracted_data?.items || []).map(
            (item) => `- [Source : ${s.documents?.title}] ${item.topic} : ${item.value}`
          )
        )
        .join("\n") +
      (Object.keys(responses).length
        ? `\n\nCompléments fournis directement par l'utilisateur :\n` +
          Object.entries(responses)
            .map(([topic, value]) => `- [Fourni par l'utilisateur] ${topic} : ${value}`)
            .join("\n")
        : "");
  } else {
    const missing = missingRequiredFields(requiredDoc.field_schema || {}, session.collected_fields);
    if (missing.length > 0) {
      return res.status(400).json({
        error: "Des informations obligatoires manquent encore : la génération est bloquée.",
        missing: missing.map((name) => requiredDoc.field_schema?.[name]?.label || name),
      });
    }
    sourceData =
      `Données collectées lors de l'entretien (seule source autorisée) :\n` +
      JSON.stringify(session.collected_fields, null, 2);
  }

  // --- Exigences des clauses couvertes (injectées depuis la base, jamais de mémoire) ---
  const { data: clauseLinks } = await supabaseAdmin
    .from("clause_documents")
    .select("clauses(number, title, requirement_text)")
    .eq("required_document_id", requirement.required_document_id);
  const clauses = (clauseLinks || [])
    .map((l) => l.clauses)
    .filter((c) => c?.requirement_text)
    .map((c) => `- Clause ${c.number} (${c.title}) : ${c.requirement_text}`)
    .join("\n");

  const today = new Date().toLocaleDateString("fr-FR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const system =
    `Vous êtes un rédacteur expert en systèmes de management ISO. Vous rédigez des documents ` +
    `professionnels, sobres et directement utilisables par une entreprise.\n\n` +
    `Règles impératives :\n` +
    `- Utilisez EXCLUSIVEMENT les informations fournies dans les données collectées. N'inventez aucun fait, ` +
    `aucun chiffre, aucun engagement qui n'y figure pas. Vous pouvez reformuler et structurer, jamais ajouter.\n` +
    `- Le document doit répondre aux exigences des clauses listées.\n` +
    `- Commencez par un cartouche : titre, référence du document, version 1.0, date du jour (${today}), ` +
    `rédacteur/approbateur si l'information est disponible dans les données.\n` +
    `- Format : Markdown propre (titres, tableaux si pertinent).\n` +
    `- Terminez par une ligne d'historique des versions.`;

  const userContent =
    `Document à produire : ${requiredDoc.title}\n\n` +
    `Description : ${requiredDoc.description}\n\n` +
    `Exigences normatives couvertes :\n${clauses || "(non précisées)"}\n\n` +
    `Consignes de structure : ${requiredDoc.generation_template || "structure professionnelle adaptée"}\n\n` +
    sourceData;

  let markdown;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    if (response.stop_reason === "refusal") throw new Error("génération refusée");
    markdown = response.content.find((b) => b.type === "text")?.text;
    if (!markdown) throw new Error("réponse vide");
  } catch (err) {
    return res.status(502).json({ error: `Génération impossible : ${err.message}` });
  }

  // --- Stockage + rattachement ---
  const path = `${profile.organization_id}/${requirement.project_id}/genere_${requiredDoc.key}_${Date.now()}.md`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from("documents")
    .upload(path, Buffer.from(markdown, "utf8"), { contentType: "text/markdown" });
  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data: doc, error: docError } = await supabaseAdmin
    .from("documents")
    .insert({
      project_id: requirement.project_id,
      organization_id: profile.organization_id,
      title: `${requiredDoc.title} (généré)`,
      storage_path: path,
      mime_type: "text/markdown",
      origin: "generated",
    })
    .select()
    .single();
  if (docError) return res.status(500).json({ error: docError.message });

  await supabaseAdmin.from("document_versions").insert({
    document_id: doc.id,
    version: 1,
    storage_path: path,
    created_by: profile.id,
  });

  await supabaseAdmin
    .from("document_requirements")
    .update({
      document_id: doc.id,
      status: "fourni",
      classification_confirmed_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requirement.id);

  await supabaseAdmin
    .from("generation_sessions")
    .update({ status: "termine", updated_at: new Date().toISOString() })
    .eq("id", session.id);

  return res.status(200).json({ documentId: doc.id, content: markdown });
}
