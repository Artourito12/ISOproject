// Crée l'organisation et le profil admin après l'inscription Supabase Auth.
// La création d'organisation passe par le service role : aucune policy RLS d'insertion
// n'existe sur organizations/profiles, c'est voulu.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token manquant" });

  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !userData?.user) return res.status(401).json({ error: "Session invalide" });

  const { organizationName, fullName } = req.body || {};
  if (!organizationName) return res.status(400).json({ error: "Nom d'organisation requis" });

  // Idempotence : si le profil existe déjà avec une organisation, ne rien recréer.
  const { data: existingProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, organization_id")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (existingProfile?.organization_id) {
    return res.status(200).json({ organizationId: existingProfile.organization_id });
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .insert({ name: organizationName })
    .select()
    .single();
  if (orgError) return res.status(500).json({ error: orgError.message });

  const { error: profileError } = await supabaseAdmin.from("profiles").upsert({
    id: userData.user.id,
    organization_id: org.id,
    role: "admin",
    full_name: fullName || null,
  });
  if (profileError) return res.status(500).json({ error: profileError.message });

  return res.status(200).json({ organizationId: org.id });
}
