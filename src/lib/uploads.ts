import { supabase } from "./supabase";

// Téléverse un fichier dans le Storage (chemin cloisonné par organisation)
// et crée la ligne documents + sa version 1. Renvoie l'id du document.
export async function uploadProjectFile(params: {
  organizationId: string;
  projectId: string;
  file: File;
  userId: string;
}): Promise<string> {
  const { organizationId, projectId, file, userId } = params;

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${organizationId}/${projectId}/${Date.now()}_${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(path, file, { contentType: file.type || undefined });
  if (uploadError) throw new Error(`Téléversement impossible : ${uploadError.message}`);

  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({
      project_id: projectId,
      organization_id: organizationId,
      title: file.name,
      storage_path: path,
      mime_type: file.type || null,
      origin: "uploaded",
    })
    .select()
    .single();
  if (insertError) throw new Error(insertError.message);

  await supabase.from("document_versions").insert({
    document_id: doc.id,
    version: 1,
    storage_path: path,
    created_by: userId,
  });

  return doc.id;
}
