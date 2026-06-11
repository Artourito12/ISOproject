// Validation expert d'une version de référentiel générée par IA.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest, isPlatformAdmin } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  if (!(await isPlatformAdmin(auth.user.id))) {
    return res.status(403).json({ error: "Accès réservé aux administrateurs de la plateforme" });
  }

  const { versionId } = req.body || {};
  if (!versionId) return res.status(400).json({ error: "versionId requis" });

  const { error } = await supabaseAdmin
    .from("standard_versions")
    .update({ validated_at: new Date().toISOString(), validated_by: auth.user.id })
    .eq("id", versionId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}
