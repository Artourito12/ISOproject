// Gestion de l'équipe (admin uniquement) : changement de rôle, retrait d'un
// membre, révocation d'une invitation en attente.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;
  if (profile.role !== "admin") {
    return res.status(403).json({ error: "Seul un administrateur peut gérer l'équipe" });
  }

  const { action, memberId, invitationId, role } = req.body || {};

  if (action === "revoke_invitation") {
    if (!invitationId) return res.status(400).json({ error: "invitationId requis" });
    const { error } = await supabaseAdmin
      .from("invitations")
      .update({ status: "revoquee" })
      .eq("id", invitationId)
      .eq("organization_id", profile.organization_id)
      .eq("status", "en_attente");
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (action === "set_role" || action === "remove") {
    if (!memberId) return res.status(400).json({ error: "memberId requis" });
    if (memberId === profile.id) {
      return res.status(400).json({ error: "Vous ne pouvez pas modifier votre propre compte" });
    }
    const { data: member } = await supabaseAdmin
      .from("profiles")
      .select("id, organization_id")
      .eq("id", memberId)
      .single();
    if (!member || member.organization_id !== profile.organization_id) {
      return res.status(404).json({ error: "Membre introuvable" });
    }

    if (action === "set_role") {
      const cleanRole = role === "admin" ? "admin" : "membre";
      const { error } = await supabaseAdmin
        .from("profiles")
        .update({ role: cleanRole })
        .eq("id", memberId);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // remove : le compte reste, il n'appartient plus à l'organisation
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ organization_id: null, role: "membre" })
      .eq("id", memberId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Action inconnue" });
}
