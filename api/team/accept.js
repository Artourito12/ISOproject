// Acceptation d'une invitation : rattache le compte connecté à l'organisation
// avec le rôle prévu par l'invitation. Idempotent.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token manquant" });
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !userData?.user) return res.status(401).json({ error: "Session invalide" });
  const user = userData.user;

  const { invitationToken, fullName } = req.body || {};
  if (!invitationToken) return res.status(400).json({ error: "invitationToken requis" });

  const { data: invitation } = await supabaseAdmin
    .from("invitations")
    .select("id, organization_id, email, role, status, expires_at, organizations(name)")
    .eq("token", invitationToken)
    .maybeSingle();
  if (!invitation) return res.status(404).json({ error: "Cette invitation n'existe pas" });

  // Idempotence : déjà membre de cette organisation
  const { data: existingProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (existingProfile?.organization_id === invitation.organization_id) {
    return res.status(200).json({
      organizationId: invitation.organization_id,
      organizationName: invitation.organizations?.name,
    });
  }
  if (existingProfile?.organization_id) {
    return res.status(409).json({
      error: "Votre compte appartient déjà à une autre organisation.",
    });
  }

  if (invitation.status !== "en_attente") {
    return res.status(410).json({ error: "Cette invitation n'est plus valable" });
  }
  if (new Date(invitation.expires_at) < new Date()) {
    return res.status(410).json({ error: "Cette invitation a expiré — demandez-en une nouvelle" });
  }

  const { error: profileError } = await supabaseAdmin.from("profiles").upsert({
    id: user.id,
    organization_id: invitation.organization_id,
    role: invitation.role,
    full_name: fullName || null,
    email: user.email || invitation.email,
  });
  if (profileError) return res.status(500).json({ error: profileError.message });

  await supabaseAdmin.from("invitations").update({ status: "acceptee" }).eq("id", invitation.id);

  return res.status(200).json({
    organizationId: invitation.organization_id,
    organizationName: invitation.organizations?.name,
  });
}
