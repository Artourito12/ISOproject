// Authentification des fonctions api/* : vérifie le Bearer token Supabase
// et renvoie l'utilisateur + son profil (organisation, rôle).
import { supabaseAdmin } from "./supabaseAdmin.js";

export async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { error: "Token manquant", status: 401 };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { error: "Session invalide", status: 401 };

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id, organization_id, role, full_name")
    .eq("id", data.user.id)
    .single();

  if (!profile?.organization_id) {
    return { error: "Profil sans organisation", status: 403 };
  }

  return { user: data.user, profile };
}
