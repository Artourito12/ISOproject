// Constitution du dossier final (cahier des charges §8) :
// contrôle final de complétude, puis assemblage des documents VALIDÉS dans une
// archive ZIP structurée par chapitre de la norme, avec sommaire.pdf et
// correspondance.pdf (table exigence ↔ preuve). Aucun appel IA : tout est
// déterministe à partir du référentiel épinglé et des encarts.
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";

export const config = { maxDuration: 300 };

const DISCLAIMER =
  "Ce dossier a été préparé et fiabilisé avec ISOproject. Il ne constitue pas une certification : " +
  "seul un organisme accrédité peut délivrer la certification, à l'issue de son propre audit.";

// Tri naturel des numéros de clause (4.1 < 4.10, 7.5 < 10.1).
function compareClauseNumbers(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

// Petit moteur de mise en page pour jsPDF : texte avec retour à la ligne
// automatique et saut de page.
function createPdfWriter() {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 56;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;

  function write(text, { size = 11, style = "normal", gapBefore = 0, gapAfter = 6 } = {}) {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    y += gapBefore;
    const lines = doc.splitTextToSize(text, width);
    for (const line of lines) {
      const lineHeight = size * 1.35;
      if (y + lineHeight > bottom) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += gapAfter;
  }

  return {
    doc,
    write,
    buffer: () => Buffer.from(doc.output("arraybuffer")),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "projectId requis" });

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select(
      "id, organization_id, name, project_standards(standard_version_id, standard_versions(edition, standards(name)))"
    )
    .eq("id", projectId)
    .single();
  if (!project || project.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Projet introuvable" });
  }
  const pinned = project.project_standards?.[0];
  const standardVersionId = pinned?.standard_version_id;
  if (!standardVersionId) return res.status(400).json({ error: "Aucune norme n'est rattachée à ce projet" });
  const standardName = pinned.standard_versions?.standards?.name || "Norme";
  const standardEdition = pinned.standard_versions?.edition || "";

  // Référentiel épinglé + encarts du projet
  const [{ data: clauses }, { data: requiredDocs }, { data: requirements }] = await Promise.all([
    supabaseAdmin
      .from("clauses")
      .select("id, number, title")
      .eq("standard_version_id", standardVersionId),
    supabaseAdmin
      .from("required_documents")
      .select("id, key, title, is_mandatory")
      .eq("standard_version_id", standardVersionId),
    supabaseAdmin
      .from("document_requirements")
      .select("id, required_document_id, status, documents(id, title, storage_path, mime_type)")
      .eq("project_id", projectId),
  ]);

  const requiredDocIds = (requiredDocs || []).map((d) => d.id);
  const { data: links } = requiredDocIds.length
    ? await supabaseAdmin
        .from("clause_documents")
        .select("clause_id, required_document_id")
        .in("required_document_id", requiredDocIds)
    : { data: [] };

  const clauseById = new Map((clauses || []).map((c) => [c.id, c]));
  const requirementByRequired = new Map((requirements || []).map((r) => [r.required_document_id, r]));
  const clausesOfRequired = new Map();
  for (const link of links || []) {
    const clause = clauseById.get(link.clause_id);
    if (!clause) continue;
    if (!clausesOfRequired.has(link.required_document_id)) clausesOfRequired.set(link.required_document_id, []);
    clausesOfRequired.get(link.required_document_id).push(clause);
  }

  // --- Contrôle final de complétude : tous les documents OBLIGATOIRES validés ---
  const missingMandatory = (requiredDocs || []).filter((rd) => {
    if (!rd.is_mandatory) return false;
    const requirement = requirementByRequired.get(rd.id);
    return !requirement || requirement.status !== "valide";
  });
  if (missingMandatory.length > 0) {
    return res.status(400).json({
      error: "Le dossier n'est pas complet : des documents obligatoires ne sont pas encore validés.",
      missing: missingMandatory.map((rd) => rd.title),
    });
  }

  // Dernier audit global terminé (joint au dossier s'il existe)
  const { data: lastAudits } = await supabaseAdmin
    .from("global_audits")
    .select("id, compliance_score, completed_at")
    .eq("project_id", projectId)
    .eq("status", "termine")
    .order("completed_at", { ascending: false })
    .limit(1);
  const lastAudit = lastAudits?.[0] || null;

  // --- Assemblage : chapitre d'accueil de chaque document = sa plus petite clause ---
  const chapterTitleByNumber = new Map(
    (clauses || []).filter((c) => !c.number.includes(".")).map((c) => [c.number, c.title])
  );

  const included = []; // {requiredDoc, document, chapter, clauses}
  for (const rd of requiredDocs || []) {
    const requirement = requirementByRequired.get(rd.id);
    if (!requirement || requirement.status !== "valide" || !requirement.documents) continue;
    const docClauses = (clausesOfRequired.get(rd.id) || []).sort((a, b) =>
      compareClauseNumbers(a.number, b.number)
    );
    const chapter = docClauses[0]?.number.split(".")[0] || "0";
    included.push({ requiredDoc: rd, document: requirement.documents, chapter, clauses: docClauses });
  }
  included.sort(
    (a, b) => Number(a.chapter) - Number(b.chapter) || a.requiredDoc.title.localeCompare(b.requiredDoc.title)
  );

  const zip = new JSZip();
  const usedPaths = new Set();
  const filePathByDocumentId = new Map();

  for (const item of included) {
    const { data: file, error: dlError } = await supabaseAdmin.storage
      .from("documents")
      .download(item.document.storage_path);
    if (dlError || !file) {
      return res
        .status(500)
        .json({ error: `Téléchargement impossible : « ${item.document.title} »` });
    }
    const buffer = Buffer.from(await file.arrayBuffer());

    const folder = `${item.chapter.padStart(2, "0")} - ${sanitizeFileName(
      chapterTitleByNumber.get(item.chapter) || "Autres"
    )}`;
    const extension = item.document.storage_path.includes(".")
      ? item.document.storage_path.split(".").pop()
      : "pdf";
    let path = `${folder}/${sanitizeFileName(item.requiredDoc.title)}.${extension}`;
    if (usedPaths.has(path)) {
      path = `${folder}/${sanitizeFileName(item.requiredDoc.title)} (${item.requiredDoc.key}).${extension}`;
    }
    usedPaths.add(path);
    filePathByDocumentId.set(item.document.id, path);
    zip.file(path, buffer);
  }

  // --- Table de correspondance exigence ↔ preuve (toutes les clauses liées) ---
  const correspondence = [];
  const sortedClauses = (clauses || [])
    .filter((c) => (links || []).some((l) => l.clause_id === c.id))
    .sort((a, b) => compareClauseNumbers(a.number, b.number));
  for (const clause of sortedClauses) {
    for (const link of (links || []).filter((l) => l.clause_id === clause.id)) {
      const rd = (requiredDocs || []).find((d) => d.id === link.required_document_id);
      if (!rd) continue;
      const requirement = requirementByRequired.get(rd.id);
      const validated = requirement?.status === "valide" && requirement.documents;
      correspondence.push({
        clause_number: clause.number,
        clause_title: clause.title,
        required_title: rd.title,
        is_mandatory: rd.is_mandatory,
        document_title: validated ? requirement.documents.title : null,
        file: validated ? filePathByDocumentId.get(requirement.documents.id) || null : null,
        status: validated ? "valide" : "non_fourni",
      });
    }
  }

  const exportDate = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // --- sommaire.pdf ---
  const sommaire = createPdfWriter();
  sommaire.write("Dossier de préparation à la certification", { size: 18, style: "bold", gapAfter: 2 });
  sommaire.write(`${standardName}${standardEdition ? ` — édition ${standardEdition}` : ""}`, {
    size: 13,
    gapAfter: 14,
  });
  sommaire.write(`Projet : ${project.name}`, { size: 11 });
  sommaire.write(`Dossier constitué le ${exportDate}`, { size: 11 });
  sommaire.write(
    lastAudit?.compliance_score != null
      ? `Score de conformité au dernier audit global : ${lastAudit.compliance_score}/100`
      : "Aucun audit global n'a été réalisé sur ce dossier.",
    { size: 11 }
  );
  sommaire.write(
    `Contrôle de complétude : ${included.length} document(s) validé(s) inclus, ` +
      `${(requiredDocs || []).filter((d) => d.is_mandatory).length} exigence(s) documentaire(s) obligatoire(s) couverte(s).`,
    { size: 11, gapAfter: 16 }
  );
  sommaire.write("Sommaire", { size: 14, style: "bold", gapAfter: 8 });
  let currentChapter = null;
  for (const item of included) {
    if (item.chapter !== currentChapter) {
      currentChapter = item.chapter;
      sommaire.write(
        `Chapitre ${item.chapter} — ${chapterTitleByNumber.get(item.chapter) || "Autres"}`,
        { size: 12, style: "bold", gapBefore: 8, gapAfter: 4 }
      );
    }
    sommaire.write(
      `• ${item.requiredDoc.title} (clauses ${item.clauses.map((c) => c.number).join(", ")}) — fichier : ${
        filePathByDocumentId.get(item.document.id) || ""
      }`,
      { size: 10, gapAfter: 2 }
    );
  }
  sommaire.write(DISCLAIMER, { size: 9, style: "italic", gapBefore: 18 });
  zip.file("sommaire.pdf", sommaire.buffer());

  // --- correspondance.pdf : exigence ↔ preuve, clause par clause ---
  const table = createPdfWriter();
  table.write("Table de correspondance exigence ↔ preuve", { size: 16, style: "bold", gapAfter: 2 });
  table.write(`${standardName} — projet « ${project.name} » — ${exportDate}`, { size: 11, gapAfter: 14 });
  let currentNumber = null;
  for (const row of correspondence) {
    if (row.clause_number !== currentNumber) {
      currentNumber = row.clause_number;
      table.write(`Clause ${row.clause_number} — ${row.clause_title}`, {
        size: 12,
        style: "bold",
        gapBefore: 8,
        gapAfter: 4,
      });
    }
    table.write(
      row.status === "valide"
        ? `• ${row.required_title} : « ${row.document_title} » (validé) — ${row.file || ""}`
        : `• ${row.required_title} : non fourni${row.is_mandatory ? "" : " (document recommandé, non obligatoire)"}`,
      { size: 10, gapAfter: 2 }
    );
  }
  table.write(DISCLAIMER, { size: 9, style: "italic", gapBefore: 18 });
  zip.file("correspondance.pdf", table.buffer());

  // --- Upload de l'archive + enregistrement de l'export ---
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const storagePath = `${profile.organization_id}/${projectId}/exports/dossier_${Date.now()}.zip`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from("documents")
    .upload(storagePath, zipBuffer, { contentType: "application/zip" });
  if (uploadError) return res.status(500).json({ error: `Enregistrement de l'archive impossible : ${uploadError.message}` });

  const { data: exportRow, error: insertError } = await supabaseAdmin
    .from("dossier_exports")
    .insert({
      project_id: projectId,
      organization_id: profile.organization_id,
      global_audit_id: lastAudit?.id || null,
      storage_path: storagePath,
      correspondence_table: correspondence,
    })
    .select()
    .single();
  if (insertError) return res.status(500).json({ error: insertError.message });

  await supabaseAdmin.from("projects").update({ status: "finalise" }).eq("id", projectId);

  return res.status(200).json({
    exportId: exportRow.id,
    storagePath,
    documentsCount: included.length,
    complianceScore: lastAudit?.compliance_score ?? null,
  });
}
