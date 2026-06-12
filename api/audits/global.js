// Audit global de conformité (cahier des charges §6) + recommandations (§7).
// Pipeline multi-passes, jamais un seul appel :
//   A. couverture (code) : clauses dont les documents requis manquent → écarts ;
//   B. audit de fond (IA) : un appel PAR document fourni, verdict par clause couverte ;
//   C. cohérence (IA) : contradictions inter-documents à partir des synthèses ;
//   D. score (code) : agrégation déterministe des verdicts, global et par chapitre.
// Chaque constat porte clause + document + explication (explicabilité obligatoire).
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { callStructured } from "../_lib/claude.js";

export const config = { maxDuration: 800 };

const CRITICALITY = { nc_majeure: 3, nc_mineure: 2, opportunite: 1, conforme: 0 };
const CLAUSE_SCORE = { conforme: 100, opportunite: 90, nc_mineure: 50, nc_majeure: 0 };

const DOC_AUDIT_SCHEMA = {
  type: "object",
  properties: {
    resume: {
      type: "string",
      description: "synthèse factuelle du contenu du document en 2-3 phrases (servira à l'analyse de cohérence inter-documents)",
    },
    verdicts: {
      type: "array",
      description: "un verdict par clause listée, aucune clause omise",
      items: {
        type: "object",
        properties: {
          clause: { type: "string", description: "numéro exact de la clause, repris de la liste fournie" },
          verdict: {
            type: "string",
            enum: ["conforme", "nc_majeure", "nc_mineure", "opportunite"],
            description:
              "conforme : le document répond au fond de l'exigence ; nc_majeure : exigence non traitée ou traitée de façon inacceptable ; nc_mineure : exigence traitée mais avec un manque ponctuel ; opportunite : conforme mais améliorable",
          },
          explanation: {
            type: "string",
            description: "raison du constat : ce que la clause exige, ce que le document contient (ou pas), au vouvoiement",
          },
          recommendation: {
            type: ["string", "null"],
            description: "action concrète suggérée (null si conforme sans réserve), au vouvoiement",
          },
        },
        required: ["clause", "verdict", "explanation", "recommendation"],
        additionalProperties: false,
      },
    },
  },
  required: ["resume", "verdicts"],
  additionalProperties: false,
};

const COHERENCE_SCHEMA = {
  type: "object",
  properties: {
    synthese: {
      type: "string",
      description: "bilan global du dossier en 4-8 phrases : points forts, faiblesses principales, priorités de correction, au vouvoiement",
    },
    contradictions: {
      type: "array",
      description: "contradictions ou incohérences ENTRE documents (vide si aucune) ; ne pas répéter les écarts déjà constatés document par document",
      items: {
        type: "object",
        properties: {
          documents: { type: "array", items: { type: "string" }, description: "titres des documents concernés" },
          clause: { type: ["string", "null"], description: "numéro de la clause la plus concernée, null si transverse" },
          description: { type: "string", description: "la contradiction constatée, avec les éléments de chaque document" },
          recommendation: { type: "string", description: "comment mettre les documents en cohérence, au vouvoiement" },
          verdict: { type: "string", enum: ["nc_majeure", "nc_mineure", "opportunite"] },
        },
        required: ["documents", "clause", "description", "recommendation", "verdict"],
        additionalProperties: false,
      },
    },
  },
  required: ["synthese", "contradictions"],
  additionalProperties: false,
};

// Exécution en parallèle bornée (les appels d'audit durent ~1 min chacun).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function worstVerdict(a, b) {
  return CRITICALITY[b] > CRITICALITY[a] ? b : a;
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
    .select("id, organization_id, name, project_standards(standard_version_id)")
    .eq("id", projectId)
    .single();
  if (!project || project.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Projet introuvable" });
  }
  const standardVersionId = project.project_standards?.[0]?.standard_version_id;
  if (!standardVersionId) return res.status(400).json({ error: "Aucune norme n'est rattachée à ce projet" });

  // Un seul audit en cours à la fois (l'exécution dure plusieurs minutes).
  const { data: running } = await supabaseAdmin
    .from("global_audits")
    .select("id, started_at")
    .eq("project_id", projectId)
    .eq("status", "en_cours")
    .gte("started_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .maybeSingle();
  if (running) {
    return res.status(409).json({ error: "Un audit est déjà en cours pour ce projet" });
  }

  // Référentiel épinglé : clauses, documents requis, liens clause ↔ document
  const [{ data: clauses }, { data: requiredDocs }, { data: requirements }] = await Promise.all([
    supabaseAdmin
      .from("clauses")
      .select("id, number, title, requirement_text")
      .eq("standard_version_id", standardVersionId),
    supabaseAdmin
      .from("required_documents")
      .select("id, key, title, description, is_mandatory")
      .eq("standard_version_id", standardVersionId),
    supabaseAdmin
      .from("document_requirements")
      .select("id, required_document_id, document_id, status, documents(id, title, storage_path, mime_type)")
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
  const clauseByNumber = new Map((clauses || []).map((c) => [c.number, c]));
  const requiredById = new Map((requiredDocs || []).map((d) => [d.id, d]));
  const clausesOfRequired = new Map(); // required_document_id -> [clause]
  for (const link of links || []) {
    const clause = clauseById.get(link.clause_id);
    if (!clause) continue;
    if (!clausesOfRequired.has(link.required_document_id)) clausesOfRequired.set(link.required_document_id, []);
    clausesOfRequired.get(link.required_document_id).push(clause);
  }

  const provided = (requirements || []).filter(
    (r) => r.document_id && r.documents && (r.status === "fourni" || r.status === "valide")
  );
  const missing = (requirements || []).filter(
    (r) => !provided.includes(r) && requiredById.has(r.required_document_id)
  );

  // Ligne d'audit créée tout de suite : le frontend suit l'avancement par polling.
  const totalSteps = provided.length + (provided.length >= 2 ? 1 : 0);
  const { data: audit, error: insertError } = await supabaseAdmin
    .from("global_audits")
    .insert({
      project_id: projectId,
      organization_id: profile.organization_id,
      status: "en_cours",
      progress: { etape: "preparation", faits: 0, total: totalSteps },
    })
    .select()
    .single();
  if (insertError) return res.status(500).json({ error: insertError.message });

  async function setProgress(etape, faits) {
    await supabaseAdmin
      .from("global_audits")
      .update({ progress: { etape, faits, total: totalSteps } })
      .eq("id", audit.id);
  }

  try {
    const findings = []; // {clause_id, document_id, verdict, explanation, recommendation, criticality}
    const clauseVerdicts = new Map(); // clause_id -> pire verdict (pour le score)

    function addFinding({ clauseId, documentId, verdict, explanation, recommendation }) {
      findings.push({
        global_audit_id: audit.id,
        organization_id: profile.organization_id,
        clause_id: clauseId,
        document_id: documentId || null,
        verdict,
        explanation,
        recommendation: recommendation || null,
        criticality: CRITICALITY[verdict],
      });
      clauseVerdicts.set(clauseId, worstVerdict(clauseVerdicts.get(clauseId) || "conforme", verdict));
    }

    // --- Passe A (code) : couverture — documents requis absents ---------------
    for (const requirement of missing) {
      const requiredDoc = requiredById.get(requirement.required_document_id);
      const verdict = requiredDoc.is_mandatory ? "nc_majeure" : "opportunite";
      for (const clause of clausesOfRequired.get(requiredDoc.id) || []) {
        addFinding({
          clauseId: clause.id,
          documentId: null,
          verdict,
          explanation:
            `La clause ${clause.number} (${clause.title}) attend la preuve « ${requiredDoc.title} », ` +
            `qui n'est pas fournie dans le dossier. ${clause.requirement_text || ""}`.trim(),
          recommendation: requiredDoc.is_mandatory
            ? `Fournissez ou créez le document « ${requiredDoc.title} » depuis l'encart correspondant du projet.`
            : `Le document « ${requiredDoc.title} » est recommandé : le fournir renforcerait votre dossier.`,
        });
      }
    }

    // --- Passe B (IA) : audit de fond, un appel par document fourni -----------
    let auditedCount = 0;
    await setProgress("audit_documents", 0);

    const docResults = await mapWithConcurrency(provided, 3, async (requirement) => {
      const doc = requirement.documents;
      const requiredDoc = requiredById.get(requirement.required_document_id);
      const docClauses = clausesOfRequired.get(requirement.required_document_id) || [];
      if (!requiredDoc || docClauses.length === 0) return null;

      const { data: file, error: dlError } = await supabaseAdmin.storage
        .from("documents")
        .download(doc.storage_path);
      if (dlError || !file) {
        throw new Error(`Téléchargement impossible : « ${doc.title} »`);
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const isPdf = doc.mime_type === "application/pdf";

      const clauseList = docClauses
        .map((c) => `- Clause ${c.number} (${c.title}) : ${c.requirement_text || "(énoncé non précisé)"}`)
        .join("\n");

      const content = [
        isPdf
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
            }
          : { type: "text", text: `Contenu du document :\n\n${buffer.toString("utf8").slice(0, 150000)}` },
        {
          type: "text",
          text:
            `Document audité : « ${doc.title} », fourni au titre de l'exigence « ${requiredDoc.title} ».\n` +
            `Ce qui est attendu : ${requiredDoc.description || "(non précisé)"}\n\n` +
            `Évaluez la conformité de fond de ce document pour CHACUNE des clauses suivantes :\n${clauseList}\n\n` +
            `Rendez un verdict par clause, sans en omettre aucune.`,
        },
      ];

      const result = await callStructured({
        system:
          "Vous réalisez l'audit global d'un dossier de certification ISO. Vous évaluez UN document, clause par clause. Règles :\n" +
          "- Jugez le FOND : la clause est-elle réellement traitée, pas seulement mentionnée ?\n" +
          "- nc_majeure : exigence absente ou vidée de sa substance. nc_mineure : manque ponctuel. " +
          "opportunite : conforme mais perfectible. conforme : répond à l'exigence.\n" +
          "- Chaque verdict cite ce que la clause exige et ce que le document contient (explicabilité).\n" +
          "- Chaque écart est accompagné d'une recommandation concrète et actionnable.\n" +
          "- N'inventez jamais un contenu absent du document.\n" +
          "- Tous les textes sont en français, au vouvoiement.",
        messages: [{ role: "user", content }],
        schema: DOC_AUDIT_SCHEMA,
        thinking: true,
        maxTokens: 12000,
      });

      auditedCount += 1;
      await setProgress("audit_documents", auditedCount);

      for (const v of result.verdicts) {
        const clause = clauseByNumber.get(v.clause) || docClauses.find((c) => c.number === v.clause);
        if (!clause) continue;
        addFinding({
          clauseId: clause.id,
          documentId: doc.id,
          verdict: v.verdict,
          explanation: v.explanation,
          recommendation: v.recommendation,
        });
      }
      return { title: doc.title, requiredTitle: requiredDoc.title, resume: result.resume, verdicts: result.verdicts };
    });

    const auditedDocs = docResults.filter(Boolean);

    // --- Passe C (IA) : cohérence inter-documents -----------------------------
    let coherence = null;
    if (auditedDocs.length >= 2) {
      await setProgress("coherence", auditedCount);
      const corpus = auditedDocs
        .map(
          (d) =>
            `Document « ${d.title} » (exigence « ${d.requiredTitle} »)\n` +
            `Synthèse : ${d.resume}\n` +
            `Constats : ${d.verdicts.map((v) => `clause ${v.clause} → ${v.verdict}`).join(", ")}`
        )
        .join("\n\n");

      coherence = await callStructured({
        system:
          "Vous analysez la COHÉRENCE D'ENSEMBLE d'un dossier de certification ISO à partir des synthèses des documents " +
          "qui le composent. Vous cherchez les contradictions entre documents (engagements divergents, périmètres " +
          "incompatibles, indicateurs incohérents, références croisées brisées) et rédigez le bilan global du dossier. " +
          "Ne répétez pas les écarts déjà constatés document par document. " +
          "Tous les textes sont en français, au vouvoiement.",
        messages: [
          {
            role: "user",
            content: `Projet : ${project.name}\n\nDocuments du dossier :\n\n${corpus}\n\nAnalysez la cohérence d'ensemble.`,
          },
        ],
        schema: COHERENCE_SCHEMA,
        thinking: true,
        maxTokens: 8000,
      });

      for (const contradiction of coherence.contradictions) {
        const clause = contradiction.clause ? clauseByNumber.get(contradiction.clause) : null;
        if (!clause) continue; // sans clause identifiable, la contradiction reste dans coherence jsonb
        addFinding({
          clauseId: clause.id,
          documentId: null,
          verdict: contradiction.verdict,
          explanation: `Incohérence entre documents (${contradiction.documents.join(", ")}) : ${contradiction.description}`,
          recommendation: contradiction.recommendation,
        });
      }
    }

    // --- Passe D (code) : score déterministe, global et par chapitre ----------
    const chapterScores = {}; // chapitre -> {sum, count}
    let sum = 0;
    for (const [clauseId, verdict] of clauseVerdicts) {
      const clause = clauseById.get(clauseId);
      const score = CLAUSE_SCORE[verdict];
      sum += score;
      const chapter = clause.number.split(".")[0];
      if (!chapterScores[chapter]) chapterScores[chapter] = { sum: 0, count: 0 };
      chapterScores[chapter].sum += score;
      chapterScores[chapter].count += 1;
    }
    const evaluated = clauseVerdicts.size;
    const complianceScore = evaluated ? Math.round(sum / evaluated) : null;
    const scoreByChapter = Object.fromEntries(
      Object.entries(chapterScores)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([chapter, s]) => [chapter, Math.round(s.sum / s.count)])
    );

    if (findings.length > 0) {
      const { error: findingsError } = await supabaseAdmin.from("audit_findings").insert(findings);
      if (findingsError) throw new Error(findingsError.message);
    }

    const hasNc = findings.some((f) => f.verdict === "nc_majeure" || f.verdict === "nc_mineure");
    await supabaseAdmin
      .from("global_audits")
      .update({
        status: "termine",
        compliance_score: complianceScore,
        score_by_chapter: scoreByChapter,
        summary: coherence?.synthese || null,
        coherence: coherence ? { contradictions: coherence.contradictions } : null,
        progress: { etape: "termine", faits: totalSteps, total: totalSteps },
        completed_at: new Date().toISOString(),
      })
      .eq("id", audit.id);

    await supabaseAdmin
      .from("projects")
      .update({ status: hasNc ? "correction" : "audit" })
      .eq("id", projectId);

    return res.status(200).json({
      globalAuditId: audit.id,
      complianceScore,
      scoreByChapter,
      findingsCount: findings.length,
      ncCount: findings.filter((f) => f.verdict.startsWith("nc_")).length,
    });
  } catch (err) {
    await supabaseAdmin
      .from("global_audits")
      .update({ status: "erreur", error_message: err.message, completed_at: new Date().toISOString() })
      .eq("id", audit.id);
    return res.status(502).json({ error: `L'audit global a échoué : ${err.message}` });
  }
}
