// Suppression RGPD d'un projet (admin uniquement) : fichiers Storage du projet
// (documents, générés, exports) puis ligne projects — la cascade base supprime
// encarts, sessions, audits, constats et exports. Les normes officielles
// (niveau organisation) ne sont pas touchées.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";

export const config = { maxDuration: 300 };

// Le Storage Supabase n'a pas de suppression récursive : on liste dossier
// par dossier avant de supprimer.
async function listAllFiles(prefix) {
  const files = [];
  const { data: entries } = await supabaseAdmin.storage
    .from("documents")
    .list(prefix, { limit: 1000 });
  for (const entry of entries || []) {
    if (entry.id) files.push(`${prefix}/${entry.name}`);
    else files.push(...(await listAllFiles(`${prefix}/${entry.name}`)));
  }
  return files;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;
  if (profile.role !== "admin") {
    return res.status(403).json({ error: "Seul un administrateur peut supprimer un projet" });
  }

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "projectId requis" });

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("id, organization_id, name")
    .eq("id", projectId)
    .single();
  if (!project || project.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Projet introuvable" });
  }

  // Fichiers du projet (documents déposés, générés, exports)
  const files = await listAllFiles(`${profile.organization_id}/${projectId}`);
  if (files.length > 0) {
    const { error: removeError } = await supabaseAdmin.storage.from("documents").remove(files);
    if (removeError) {
      return res.status(500).json({ error: `Suppression des fichiers impossible : ${removeError.message}` });
    }
  }

  const { error: deleteError } = await supabaseAdmin.from("projects").delete().eq("id", projectId);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  return res.status(200).json({ deleted: true, filesRemoved: files.length });
}
