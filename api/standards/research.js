// Génération de référentiel à la demande — ÉTAPE 2/3 : recherche web approfondie.
// Idempotente : si les notes existent déjà, renvoie immédiatement (rejouable après coupure).
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { anthropic, MODEL } from "../_lib/claude.js";

export const config = { maxDuration: 800 };

async function loadJson(path) {
  const { data } = await supabaseAdmin.storage.from("documents").download(path);
  if (!data) return null;
  return JSON.parse(await data.text());
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
    .select("id, organization_id, status")
    .eq("id", requestId)
    .single();
  if (!request || request.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Demande introuvable" });
  }

  const base = `_system/standard_requests/${requestId}`;

  // Idempotence : notes déjà produites ?
  const { data: existingNotes } = await supabaseAdmin.storage
    .from("documents")
    .download(`${base}/notes.txt`);
  if (existingNotes) return res.status(200).json({ ok: true, cached: true });

  const id = await loadJson(`${base}/identity.json`);
  if (!id) return res.status(400).json({ error: "Étape d'identification manquante" });

  try {
    let messages = [
      {
        role: "user",
        content:
          `Recherchez tout ce qui est nécessaire pour préparer un dossier de certification ${id.name} (édition ${id.edition}).\n` +
          `Je veux des notes de travail détaillées et fiables couvrant :\n` +
          `1. La structure exacte des chapitres et clauses de la norme (numéros et intitulés), et pour chaque clause le sens de l'exigence.\n` +
          `2. La liste des informations documentées obligatoires (documents et enregistrements exigés explicitement).\n` +
          `3. Les documents et preuves habituellement attendus par les auditeurs de certification.\n` +
          `4. Les spécificités réglementaires françaises pertinentes le cas échéant.\n` +
          `Vérifiez l'édition en vigueur. Reformulez toujours les exigences (le texte officiel est protégé par le droit d'auteur).`,
      },
    ];

    let response;
    for (let i = 0; i < 4; i++) {
      response = await anthropic.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        system:
          "Vous êtes un expert en certification ISO. Vous produisez des notes de recherche précises, structurées et sourcées, en français. Soyez efficace : pas plus de 5 recherches.",
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages,
      }).finalMessage();
      if (response.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: response.content }];
    }
    if (response.stop_reason === "refusal") throw new Error("recherche refusée");

    const notes = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!notes.trim()) throw new Error("recherche sans résultat");

    await supabaseAdmin.storage
      .from("documents")
      .upload(`${base}/notes.txt`, Buffer.from(notes, "utf8"), {
        contentType: "text/plain",
        upsert: true,
      });

    return res.status(200).json({ ok: true });
  } catch (err) {
    await supabaseAdmin
      .from("standard_requests")
      .update({ status: "erreur", error_message: `Recherche : ${err.message}` })
      .eq("id", requestId);
    return res.status(502).json({ error: `La recherche a échoué : ${err.message}` });
  }
}
