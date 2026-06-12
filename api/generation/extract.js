// Cas 2 — création par extraction de documents sources (cahier des charges §5.3).
// Chaque donnée extraite porte sa source (document + extrait verbatim) : règle de
// non-fabrication. Une passe d'analyse identifie ensuite les informations encore
// manquantes au regard du modèle de génération : elles seront DEMANDÉES à
// l'utilisateur, jamais inventées.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";

export const config = { maxDuration: 800 };

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "données utiles au document cible, réellement présentes dans la source (vide si rien d'utile)",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", description: "intitulé court et explicite de la donnée (ex: « Effectif total », « Indicateur satisfaction client 2025 »)" },
          value: { type: "string", description: "la donnée extraite, fidèle à la source ; chiffres et dates exacts" },
          source_excerpt: { type: "string", description: "court extrait VERBATIM du passage source d'où provient la donnée (max 200 caractères)" },
        },
        required: ["topic", "value", "source_excerpt"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const GAP_SCHEMA = {
  type: "object",
  properties: {
    missing: {
      type: "array",
      description: "informations indispensables au document cible qui ne figurent dans AUCUNE donnée extraite (vide si tout est couvert)",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", description: "intitulé court de l'information manquante" },
          question: { type: "string", description: "question claire à poser à l'utilisateur pour l'obtenir, au vouvoiement, avec un exemple si utile" },
        },
        required: ["topic", "question"],
        additionalProperties: false,
      },
    },
  },
  required: ["missing"],
  additionalProperties: false,
};

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { requirementId, documentIds } = req.body || {};
  if (!requirementId || !Array.isArray(documentIds) || documentIds.length === 0) {
    return res.status(400).json({ error: "requirementId et au moins un document source sont requis" });
  }

  const { data: requirement } = await supabaseAdmin
    .from("document_requirements")
    .select(
      "id, project_id, organization_id, required_document_id, " +
        "required_documents(key, title, description, generation_case, source_hints, generation_template)"
    )
    .eq("id", requirementId)
    .single();
  if (!requirement || requirement.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Encart introuvable" });
  }
  const requiredDoc = requirement.required_documents;
  if (requiredDoc.generation_case !== 2) {
    return res.status(400).json({ error: "Ce document ne se crée pas par extraction de documents sources" });
  }

  // Documents sources : ils doivent appartenir au même projet
  const { data: sources } = await supabaseAdmin
    .from("documents")
    .select("id, title, storage_path, mime_type")
    .in("id", documentIds)
    .eq("project_id", requirement.project_id);
  if (!sources || sources.length !== documentIds.length) {
    return res.status(400).json({ error: "Un des documents sources est introuvable dans ce projet" });
  }

  // Session existante (réutilisée si l'utilisateur ajoute des sources) ou nouvelle
  const { data: existing } = await supabaseAdmin
    .from("generation_sessions")
    .select("*")
    .eq("document_requirement_id", requirement.id)
    .neq("status", "termine")
    .maybeSingle();
  let session = existing;
  if (!session) {
    const { data: created, error: createError } = await supabaseAdmin
      .from("generation_sessions")
      .insert({
        document_requirement_id: requirement.id,
        organization_id: profile.organization_id,
        generation_case: 2,
        status: "extraction",
        collected_fields: { missing: [], responses: {} },
      })
      .select()
      .single();
    if (createError) return res.status(500).json({ error: createError.message });
    session = created;
  }

  // Exigences des clauses couvertes (depuis la base)
  const { data: clauseLinks } = await supabaseAdmin
    .from("clause_documents")
    .select("clauses(number, title, requirement_text)")
    .eq("required_document_id", requirement.required_document_id);
  const clauses = (clauseLinks || [])
    .map((l) => l.clauses)
    .filter((c) => c?.requirement_text)
    .map((c) => `- Clause ${c.number} (${c.title}) : ${c.requirement_text}`)
    .join("\n");

  const targetDescription =
    `Document cible : ${requiredDoc.title}\n` +
    `Ce qui est attendu : ${requiredDoc.description}\n` +
    `Structure attendue : ${requiredDoc.generation_template || "structure professionnelle adaptée"}\n` +
    `Exigences normatives couvertes :\n${clauses || "(non précisées)"}`;

  // --- Extraction : un appel PAR document source (contexte isolé, traçabilité) ---
  let extractions;
  try {
    extractions = await mapWithConcurrency(sources, 3, async (source) => {
      const { data: file, error: dlError } = await supabaseAdmin.storage
        .from("documents")
        .download(source.storage_path);
      if (dlError || !file) throw new Error(`téléchargement impossible : « ${source.title} »`);
      const buffer = Buffer.from(await file.arrayBuffer());
      const isPdf = source.mime_type === "application/pdf";

      const content = [
        isPdf
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
            }
          : { type: "text", text: `Contenu du document source :\n\n${buffer.toString("utf8").slice(0, 150000)}` },
        {
          type: "text",
          text:
            `${targetDescription}\n\n` +
            `Document source analysé : « ${source.title} ».\n\n` +
            `Extrayez de ce document source toutes les données utiles à la constitution du document cible.`,
        },
      ];

      const result = await callStructured({
        system:
          "Vous extrayez des données d'un document source pour constituer un document de système de management ISO. " +
          "Règles impératives :\n" +
          "- N'extrayez QUE ce qui figure réellement dans le document source. N'inférez rien, ne complétez rien.\n" +
          "- Chaque donnée extraite est accompagnée d'un extrait VERBATIM du passage d'où elle provient.\n" +
          "- Chiffres, dates et noms : reprenez-les exactement.\n" +
          "- Si le document ne contient rien d'utile pour le document cible, renvoyez une liste vide.\n" +
          "- Tous les textes sont en français, au vouvoiement.",
        messages: [{ role: "user", content }],
        schema: EXTRACT_SCHEMA,
        maxTokens: 8000,
      });
      return { source, items: result.items };
    });
  } catch (err) {
    return res.status(502).json({ error: `L'extraction a échoué : ${err.message}` });
  }

  // Remplacement des extractions précédentes de ces sources (re-extraction possible)
  await supabaseAdmin
    .from("extraction_sources")
    .delete()
    .eq("generation_session_id", session.id)
    .in("document_id", documentIds);
  const { error: insertError } = await supabaseAdmin.from("extraction_sources").insert(
    extractions.map((e) => ({
      generation_session_id: session.id,
      organization_id: profile.organization_id,
      document_id: e.source.id,
      extracted_data: { items: e.items },
    }))
  );
  if (insertError) return res.status(500).json({ error: insertError.message });

  // --- Analyse des manques : ce que les sources ne couvrent pas sera DEMANDÉ ---
  const { data: allSources } = await supabaseAdmin
    .from("extraction_sources")
    .select("document_id, extracted_data, documents(title)")
    .eq("generation_session_id", session.id);
  const allItems = (allSources || []).flatMap((s) =>
    (s.extracted_data?.items || []).map((item) => `- [${s.documents?.title}] ${item.topic} : ${item.value}`)
  );

  let gap;
  try {
    gap = await callStructured({
      system:
        "Vous vérifiez si les données extraites de documents sources suffisent à constituer un document de système " +
        "de management ISO. Listez UNIQUEMENT les informations indispensables qui manquent : elles seront demandées " +
        "à l'utilisateur (jamais inventées). Ne listez pas ce qui est simplement perfectible : seulement ce qui " +
        "empêche de produire un document complet et honnête. Regroupez les manques (5 maximum). " +
        "Tous les textes sont en français, au vouvoiement.",
      messages: [
        {
          role: "user",
          content:
            `${targetDescription}\n\n` +
            `Données extraites des documents sources :\n${allItems.join("\n") || "(aucune donnée extraite)"}\n\n` +
            `Quelles informations indispensables manquent encore ?`,
        },
      ],
      schema: GAP_SCHEMA,
      maxTokens: 4000,
    });
  } catch (err) {
    return res.status(502).json({ error: `L'analyse des manques a échoué : ${err.message}` });
  }

  // Les réponses déjà données par l'utilisateur sont conservées si le sujet réapparaît
  const previousResponses = session.collected_fields?.responses || {};
  const responses = {};
  for (const m of gap.missing) {
    if (previousResponses[m.topic]) responses[m.topic] = previousResponses[m.topic];
  }

  const { error: saveError } = await supabaseAdmin
    .from("generation_sessions")
    .update({
      status: "revue",
      collected_fields: { missing: gap.missing, responses },
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
  if (saveError) return res.status(500).json({ error: saveError.message });

  return res.status(200).json({
    sessionId: session.id,
    extractions: (allSources || []).map((s) => ({
      documentId: s.document_id,
      documentTitle: s.documents?.title,
      items: s.extracted_data?.items || [],
    })),
    missing: gap.missing,
    responses,
  });
}
