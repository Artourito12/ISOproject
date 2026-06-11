// Vue d'ensemble du dashboard super admin : catalogue de normes
// (avec origine et état de validation) + dernières demandes clients.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest, isPlatformAdmin } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  if (!(await isPlatformAdmin(auth.user.id))) {
    return res.status(403).json({ error: "Accès réservé aux administrateurs de la plateforme" });
  }

  const [{ data: versions }, { data: requests }] = await Promise.all([
    supabaseAdmin
      .from("standard_versions")
      .select("id, edition, referential_version, is_current, origin, validated_at, published_at, standards(code, name)")
      .order("published_at", { ascending: false }),
    supabaseAdmin
      .from("standard_requests")
      .select("id, query, status, error_message, created_at, organizations(name), standards(code, name)")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  return res.status(200).json({ versions: versions ?? [], requests: requests ?? [] });
}
