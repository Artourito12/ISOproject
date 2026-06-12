// Invitation d'un membre dans l'organisation (admin uniquement).
// Tant que le SMTP Resend n'est pas configuré, l'invitation est un lien
// que l'admin copie et transmet lui-même.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;
  if (profile.role !== "admin") {
    return res.status(403).json({ error: "Seul un administrateur peut inviter des membres" });
  }

  const { email, role } = req.body || {};
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "Adresse email invalide" });
  }
  const cleanRole = role === "admin" ? "admin" : "membre";

  // Déjà membre ?
  const { data: existingMember } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("organization_id", profile.organization_id)
    .eq("email", cleanEmail)
    .maybeSingle();
  if (existingMember) {
    return res.status(409).json({ error: "Cette personne fait déjà partie de votre organisation" });
  }

  // Invitation en attente déjà existante : on renvoie le même lien (idempotent)
  const { data: pending } = await supabaseAdmin
    .from("invitations")
    .select("id, token")
    .eq("organization_id", profile.organization_id)
    .eq("email", cleanEmail)
    .eq("status", "en_attente")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (pending) {
    return res.status(200).json({ token: pending.token, alreadyInvited: true });
  }

  const { data: invitation, error: insertError } = await supabaseAdmin
    .from("invitations")
    .insert({
      organization_id: profile.organization_id,
      email: cleanEmail,
      role: cleanRole,
      invited_by: profile.id,
    })
    .select()
    .single();
  if (insertError) return res.status(500).json({ error: insertError.message });

  return res.status(200).json({ token: invitation.token, alreadyInvited: false });
}
