// Crée un projet de certification : épingle la version courante du référentiel
// et matérialise les ENCARTS (une ligne document_requirements par document requis).
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { name, standardCode } = req.body || {};
  if (!name || !standardCode) {
    return res.status(400).json({ error: "Nom du projet et code de norme requis" });
  }

  // Version courante du référentiel pour la norme demandée
  const { data: standard } = await supabaseAdmin
    .from("standards")
    .select("id, code, standard_versions(id, is_current)")
    .eq("code", standardCode)
    .eq("is_active", true)
    .single();

  const currentVersion = standard?.standard_versions?.find((v) => v.is_current);
  if (!currentVersion) {
    return res.status(404).json({ error: "Norme inconnue ou sans référentiel publié" });
  }

  const { data: project, error: projectError } = await supabaseAdmin
    .from("projects")
    .insert({ organization_id: profile.organization_id, name })
    .select()
    .single();
  if (projectError) return res.status(500).json({ error: projectError.message });

  await supabaseAdmin
    .from("project_standards")
    .insert({ project_id: project.id, standard_version_id: currentVersion.id });

  // Encarts : un par document requis de la version épinglée
  const { data: requiredDocs, error: reqError } = await supabaseAdmin
    .from("required_documents")
    .select("id")
    .eq("standard_version_id", currentVersion.id);
  if (reqError) return res.status(500).json({ error: reqError.message });

  const { error: encartsError } = await supabaseAdmin.from("document_requirements").insert(
    requiredDocs.map((d) => ({
      project_id: project.id,
      organization_id: profile.organization_id,
      required_document_id: d.id,
    }))
  );
  if (encartsError) return res.status(500).json({ error: encartsError.message });

  return res.status(200).json({ projectId: project.id, encarts: requiredDocs.length });
}
