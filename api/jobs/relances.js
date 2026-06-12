// Relances hebdomadaires sur les actions correctives (cahier des charges §9).
// Déclenché par Vercel Cron (GET, Authorization: Bearer CRON_SECRET, automatique
// dès que la variable CRON_SECRET existe). Un digest par organisation, envoyé
// aux administrateurs : projets avec non-conformités ouvertes depuis plus de
// RELANCE_DELAY_DAYS jours après l'audit.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";

const RELANCE_DELAY_DAYS = 3;
const APP_URL = process.env.APP_URL || "https://isoproject-rho.vercel.app";

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ skipped: "RESEND_API_KEY non configurée : aucune relance envoyée" });
  }

  // Dernier audit global terminé de chaque projet, assez ancien pour relancer
  const cutoff = new Date(Date.now() - RELANCE_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: audits } = await supabaseAdmin
    .from("global_audits")
    .select("id, project_id, organization_id, compliance_score, completed_at")
    .eq("status", "termine")
    .order("completed_at", { ascending: false });
  const latestByProject = new Map();
  for (const audit of audits || []) {
    if (!latestByProject.has(audit.project_id)) latestByProject.set(audit.project_id, audit);
  }
  const eligible = [...latestByProject.values()].filter((a) => a.completed_at <= cutoff);
  if (eligible.length === 0) return res.status(200).json({ sent: 0, reason: "aucun audit éligible" });

  // Non-conformités encore ouvertes sur ces audits
  const { data: findings } = await supabaseAdmin
    .from("audit_findings")
    .select("global_audit_id, verdict")
    .in("global_audit_id", eligible.map((a) => a.id))
    .eq("status", "ouvert")
    .in("verdict", ["nc_majeure", "nc_mineure"]);
  const ncByAudit = new Map();
  for (const f of findings || []) {
    const counts = ncByAudit.get(f.global_audit_id) || { majeures: 0, mineures: 0 };
    if (f.verdict === "nc_majeure") counts.majeures += 1;
    else counts.mineures += 1;
    ncByAudit.set(f.global_audit_id, counts);
  }

  const toRelance = eligible.filter((a) => ncByAudit.has(a.id));
  if (toRelance.length === 0) return res.status(200).json({ sent: 0, reason: "aucune NC ouverte" });

  // Noms de projets + admins de chaque organisation
  const [{ data: projects }, { data: admins }] = await Promise.all([
    supabaseAdmin
      .from("projects")
      .select("id, name, organization_id")
      .in("id", toRelance.map((a) => a.project_id)),
    supabaseAdmin
      .from("profiles")
      .select("organization_id, email, full_name")
      .in("organization_id", [...new Set(toRelance.map((a) => a.organization_id))])
      .eq("role", "admin")
      .not("email", "is", null),
  ]);
  const projectById = new Map((projects || []).map((p) => [p.id, p]));

  // Un digest par organisation
  const byOrg = new Map();
  for (const audit of toRelance) {
    if (!byOrg.has(audit.organization_id)) byOrg.set(audit.organization_id, []);
    byOrg.get(audit.organization_id).push(audit);
  }

  let sent = 0;
  const errors = [];
  for (const [orgId, orgAudits] of byOrg) {
    const recipients = (admins || []).filter((a) => a.organization_id === orgId).map((a) => a.email);
    if (recipients.length === 0) continue;

    const rows = orgAudits
      .map((audit) => {
        const project = projectById.get(audit.project_id);
        const counts = ncByAudit.get(audit.id);
        const days = Math.floor((Date.now() - new Date(audit.completed_at).getTime()) / 86400000);
        return (
          `<tr>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e4e7ec;">${escapeHtml(project?.name || "Projet")}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e4e7ec;">${counts.majeures} majeure(s), ${counts.mineures} mineure(s)</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e4e7ec;">il y a ${days} jour(s)</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e4e7ec;">` +
          `<a href="${APP_URL}/projets/${audit.project_id}/audit" style="color:#1e40af;">Corriger</a></td>` +
          `</tr>`
        );
      })
      .join("");

    const html =
      `<div style="font-family:'IBM Plex Sans',system-ui,sans-serif;color:#344054;font-size:14px;max-width:640px;">` +
      `<h2 style="color:#101828;">Des actions correctives attendent votre attention</h2>` +
      `<p>Des non-conformités relevées par l'audit global de vos projets de certification ` +
      `sont toujours ouvertes. Les corriger améliore votre score de conformité avant la ` +
      `constitution du dossier final.</p>` +
      `<table style="border-collapse:collapse;width:100%;font-size:13px;">` +
      `<tr><th align="left" style="padding:8px 12px;color:#667085;">Projet</th>` +
      `<th align="left" style="padding:8px 12px;color:#667085;">Écarts ouverts</th>` +
      `<th align="left" style="padding:8px 12px;color:#667085;">Audité</th><th></th></tr>` +
      rows +
      `</table>` +
      `<p style="margin-top:16px;">Une fois les documents corrigés, relancez l'audit global pour mettre à jour votre score.</p>` +
      `<p style="color:#98a2b3;font-size:12px;">Vous recevez cet email car vous êtes administrateur de votre organisation sur ISOproject. ` +
      `Cet outil est une aide à la préparation : la certification ne peut être délivrée que par un organisme accrédité.</p>` +
      `</div>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "ISOproject <onboarding@resend.dev>",
        to: recipients,
        subject: "Vos actions correctives ISO en attente",
        html,
      }),
    });
    if (response.ok) sent += 1;
    else errors.push(`org ${orgId} : ${(await response.json().catch(() => ({})))?.message || response.status}`);
  }

  return res.status(200).json({ sent, organisations: byOrg.size, errors });
}
