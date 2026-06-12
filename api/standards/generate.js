// Génération de référentiel à la demande — ÉTAPE 1/3 : identification.
// Pipeline en 3 appels chaînés par le client (chaque étape persiste son résultat) :
//   1. generate.js  : identifie la norme, crée la demande          (~15 s)
//   2. research.js  : recherche web approfondie, notes en storage  (~2-4 min)
//   3. build.js     : structuration + insertion du référentiel     (~4-7 min)
// Le client suit aussi standard_requests.status en filet de sécurité.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest, isPlatformAdmin } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";

export const config = { maxDuration: 300 };

// Quota anti-abus : la préparation d'une norme coûte ~10 min de pipeline IA.
const MAX_REQUESTS_PER_DAY = 3;

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { query } = req.body || {};
  if (!query || String(query).trim().length < 3) {
    return res.status(400).json({ error: "Précisez la norme recherchée (ex. ISO 13485)" });
  }

  // Quota par organisation sur 24h glissantes (les super admins n'y sont pas soumis)
  if (!(await isPlatformAdmin(profile.id))) {
    const { count } = await supabaseAdmin
      .from("standard_requests")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", profile.organization_id)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= MAX_REQUESTS_PER_DAY) {
      return res.status(429).json({
        error:
          `Votre organisation a déjà demandé la préparation de ${MAX_REQUESTS_PER_DAY} normes ces dernières 24 heures. ` +
          `Réessayez demain, ou contactez-nous si vous avez un besoin particulier.`,
      });
    }
  }

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

  // Déjà au catalogue ?
  const { data: existing } = await supabaseAdmin
    .from("standards")
    .select("id, code, name, standard_versions(id, is_current)")
    .eq("code", id.code)
    .maybeSingle();
  if (existing?.standard_versions?.some((v) => v.is_current)) {
    return res.status(200).json({ existing: true, code: existing.code, name: existing.name });
  }

  const { data: request, error: reqError } = await supabaseAdmin
    .from("standard_requests")
    .insert({
      organization_id: profile.organization_id,
      requested_by: profile.id,
      query: String(query).trim(),
    })
    .select()
    .single();
  if (reqError) return res.status(500).json({ error: reqError.message });

  // L'identité de la norme sert aux étapes suivantes
  await supabaseAdmin.storage
    .from("documents")
    .upload(`_system/standard_requests/${request.id}/identity.json`, Buffer.from(JSON.stringify(id), "utf8"), {
      contentType: "application/json",
      upsert: true,
    });

  return res.status(200).json({
    existing: false,
    requestId: request.id,
    code: id.code,
    name: id.name,
    edition: id.edition,
  });
}
