// Chat IA du projet (V0.21) — boucle agentique avec outils.
// Principes :
//  - périmètre strict (certification, normes, conformité réglementaire liée) ;
//  - le modèle VÉRIFIE l'état réel (outils) avant de répondre, et pose des
//    questions de clarification quand le contexte manque ;
//  - hiérarchie des sources : norme officielle déposée > référentiel en base >
//    données du projet > recherche web (sources officielles privilégiées) ;
//  - citation obligatoire, jamais de longs extraits de la norme (texte protégé).
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { getUserFromRequest } from "../_lib/auth.js";
import { anthropic, MODEL } from "../_lib/claude.js";

export const config = { maxDuration: 800 };

const MAX_TOOL_TURNS = 8;
const TRANSCRIPT_LIMIT = 30; // messages conservés pour le contexte

const TOOLS = [
  {
    name: "etat_du_projet",
    description:
      "État réel du projet : encarts (documents requis) avec leur statut et le document fourni, statut du projet, " +
      "dernier audit global (score, date, non-conformités ouvertes). À utiliser avant toute réponse sur l'avancement.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "lire_clause",
    description:
      "Référentiel de la norme du projet. Sans numéro : liste de toutes les clauses (numéro + titre). " +
      "Avec un numéro (ex: '7.5') : énoncé de l'exigence et documents requis associés avec leur statut dans le projet.",
    input_schema: {
      type: "object",
      properties: {
        numero: { type: ["string", "null"], description: "numéro de clause, ou null pour la liste complète" },
      },
      required: ["numero"],
      additionalProperties: false,
    },
  },
  {
    name: "constats_audit",
    description:
      "Constats du dernier audit global terminé : verdict par clause, explication, recommandation, statut de correction. " +
      "Filtrable par numéro de clause.",
    input_schema: {
      type: "object",
      properties: {
        clause: { type: ["string", "null"], description: "numéro de clause pour filtrer, ou null pour tout" },
      },
      required: ["clause"],
      additionalProperties: false,
    },
  },
  {
    name: "lire_document",
    description:
      "Lit un document du projet (PDF — y compris scanné — ou texte) et répond à une question précise sur son contenu, " +
      "avec citations. Utilisez l'identifiant renvoyé par etat_du_projet.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "identifiant du document" },
        question: { type: "string", description: "ce que vous cherchez dans le document" },
      },
      required: ["document_id", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "consulter_norme_officielle",
    description:
      "Consulte le texte officiel de la norme SI l'organisation l'a déposé. Source prioritaire sur le référentiel : " +
      "répond avec le numéro de clause et la page, sans reproduire de longs extraits.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "ce que vous cherchez dans le texte officiel" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
];

const TOOL_LABELS = {
  etat_du_projet: "état du projet",
  lire_clause: "référentiel de la norme",
  constats_audit: "constats d'audit",
  lire_document: "documents du projet",
  consulter_norme_officielle: "norme officielle déposée",
  web_search: "recherche web",
};

// Lecture d'un PDF (OCR natif Claude) ciblée par une question, avec citations.
async function askDocument({ buffer, mimeType, title, question, system }) {
  const isPdf = mimeType === "application/pdf";
  const content = [
    isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }
      : { type: "text", text: `Contenu du document :\n\n${buffer.toString("utf8").slice(0, 150000)}` },
    { type: "text", text: `Document : « ${title} ».\n\nQuestion : ${question}` },
  ];
  const response = await anthropic.messages
    .stream({ model: MODEL, max_tokens: 3000, system, messages: [{ role: "user", content }] })
    .finalMessage();
  return response.content.find((b) => b.type === "text")?.text || "(aucune réponse)";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const auth = await getUserFromRequest(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { profile } = auth;

  const { projectId, message } = req.body || {};
  if (!projectId || !message || !String(message).trim()) {
    return res.status(400).json({ error: "projectId et message requis" });
  }

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select(
      "id, organization_id, name, status, " +
        "project_standards(standard_version_id, standard_versions(edition, standard_id, standards(name)))"
    )
    .eq("id", projectId)
    .single();
  if (!project || project.organization_id !== profile.organization_id) {
    return res.status(404).json({ error: "Projet introuvable" });
  }
  const pinned = project.project_standards?.[0];
  const standardVersionId = pinned?.standard_version_id;
  const standardId = pinned?.standard_versions?.standard_id;
  const standardName = pinned?.standard_versions?.standards?.name || "la norme";
  const standardEdition = pinned?.standard_versions?.edition || "";

  // Session de chat : la plus récente du projet
  let { data: session } = await supabaseAdmin
    .from("chat_sessions")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) {
    const { data: created, error: createError } = await supabaseAdmin
      .from("chat_sessions")
      .insert({ project_id: projectId, organization_id: profile.organization_id })
      .select()
      .single();
    if (createError) return res.status(500).json({ error: createError.message });
    session = created;
  }

  // Norme officielle déposée ? (signalé dans le prompt système)
  const { data: officialNorm } = standardId
    ? await supabaseAdmin
        .from("official_standard_documents")
        .select("id, title, storage_path")
        .eq("organization_id", profile.organization_id)
        .eq("standard_id", standardId)
        .maybeSingle()
    : { data: null };

  // ---------- Exécuteurs d'outils ----------
  async function runTool(name, input) {
    if (name === "etat_du_projet") {
      const [{ data: requirements }, { data: audits }] = await Promise.all([
        supabaseAdmin
          .from("document_requirements")
          .select(
            "status, required_documents(key, title, is_mandatory, generation_case), documents(id, title, origin)"
          )
          .eq("project_id", projectId),
        supabaseAdmin
          .from("global_audits")
          .select("id, compliance_score, completed_at")
          .eq("project_id", projectId)
          .eq("status", "termine")
          .order("completed_at", { ascending: false })
          .limit(1),
      ]);
      const audit = audits?.[0] || null;
      let openNc = 0;
      if (audit) {
        const { count } = await supabaseAdmin
          .from("audit_findings")
          .select("id", { count: "exact", head: true })
          .eq("global_audit_id", audit.id)
          .eq("status", "ouvert")
          .in("verdict", ["nc_majeure", "nc_mineure"]);
        openNc = count ?? 0;
      }
      return JSON.stringify({
        statut_projet: project.status,
        encarts: (requirements || []).map((r) => ({
          exigence: r.required_documents?.title,
          obligatoire: r.required_documents?.is_mandatory,
          statut: r.status,
          document: r.documents ? { id: r.documents.id, titre: r.documents.title, origine: r.documents.origin } : null,
        })),
        dernier_audit_global: audit
          ? { score: audit.compliance_score, date: audit.completed_at, nc_ouvertes: openNc }
          : null,
        norme_officielle_deposee: Boolean(officialNorm),
      });
    }

    if (name === "lire_clause") {
      if (!input.numero) {
        const { data: clauses } = await supabaseAdmin
          .from("clauses")
          .select("number, title")
          .eq("standard_version_id", standardVersionId)
          .order("sort_order");
        return (clauses || []).map((c) => `${c.number} — ${c.title}`).join("\n") || "Référentiel vide";
      }
      const { data: clause } = await supabaseAdmin
        .from("clauses")
        .select("id, number, title, requirement_text")
        .eq("standard_version_id", standardVersionId)
        .eq("number", String(input.numero).trim())
        .maybeSingle();
      if (!clause) return `Clause ${input.numero} introuvable dans le référentiel.`;
      const { data: links } = await supabaseAdmin
        .from("clause_documents")
        .select("required_documents(id, title, is_mandatory)")
        .eq("clause_id", clause.id);
      const requiredIds = (links || []).map((l) => l.required_documents?.id).filter(Boolean);
      const { data: reqs } = requiredIds.length
        ? await supabaseAdmin
            .from("document_requirements")
            .select("required_document_id, status")
            .eq("project_id", projectId)
            .in("required_document_id", requiredIds)
        : { data: [] };
      const statusByRequired = new Map((reqs || []).map((r) => [r.required_document_id, r.status]));
      return JSON.stringify({
        clause: `${clause.number} — ${clause.title}`,
        exigence_reformulee: clause.requirement_text || "(chapitre sans exigence directe)",
        documents_requis: (links || []).map((l) => ({
          titre: l.required_documents?.title,
          obligatoire: l.required_documents?.is_mandatory,
          statut_dans_le_projet: statusByRequired.get(l.required_documents?.id) || "a_fournir",
        })),
        note: "Énoncé REFORMULÉ. Pour le texte exact, consulter la norme officielle déposée si disponible.",
      });
    }

    if (name === "constats_audit") {
      const { data: audits } = await supabaseAdmin
        .from("global_audits")
        .select("id, compliance_score, completed_at")
        .eq("project_id", projectId)
        .eq("status", "termine")
        .order("completed_at", { ascending: false })
        .limit(1);
      const audit = audits?.[0];
      if (!audit) return "Aucun audit global n'a encore été réalisé sur ce projet.";
      const { data: findings } = await supabaseAdmin
        .from("audit_findings")
        .select("verdict, explanation, recommendation, status, clauses(number, title), documents(title)")
        .eq("global_audit_id", audit.id)
        .order("criticality", { ascending: false })
        .limit(40);
      const filtered = input.clause
        ? (findings || []).filter((f) => f.clauses?.number === String(input.clause).trim())
        : findings || [];
      return JSON.stringify({
        score: audit.compliance_score,
        date: audit.completed_at,
        constats: filtered.map((f) => ({
          clause: f.clauses ? `${f.clauses.number} — ${f.clauses.title}` : null,
          document: f.documents?.title || null,
          verdict: f.verdict,
          explication: f.explanation,
          recommandation: f.recommendation,
          statut: f.status,
        })),
      });
    }

    if (name === "lire_document") {
      const { data: doc } = await supabaseAdmin
        .from("documents")
        .select("id, title, storage_path, mime_type, project_id")
        .eq("id", input.document_id)
        .maybeSingle();
      if (!doc || doc.project_id !== projectId) return "Document introuvable dans ce projet.";
      const { data: file, error: dlError } = await supabaseAdmin.storage
        .from("documents")
        .download(doc.storage_path);
      if (dlError || !file) return `Téléchargement impossible : « ${doc.title} ».`;
      return askDocument({
        buffer: Buffer.from(await file.arrayBuffer()),
        mimeType: doc.mime_type,
        title: doc.title,
        question: input.question,
        system:
          "Vous répondez à une question sur un document d'un dossier de certification. Citez les passages pertinents " +
          "entre guillemets. Si l'information n'est pas dans le document, dites-le clairement. N'inventez rien. " +
          "Français, réponse factuelle et concise.",
      });
    }

    if (name === "consulter_norme_officielle") {
      if (!officialNorm) {
        return (
          "Aucune norme officielle n'a été déposée pour cette organisation. " +
          "Suggérez à l'utilisateur de déposer son exemplaire officiel depuis la page du projet pour des réponses au texte exact."
        );
      }
      const { data: file, error: dlError } = await supabaseAdmin.storage
        .from("documents")
        .download(officialNorm.storage_path);
      if (dlError || !file) return "Le texte officiel déposé n'a pas pu être lu.";
      return askDocument({
        buffer: Buffer.from(await file.arrayBuffer()),
        mimeType: "application/pdf",
        title: officialNorm.title,
        question: input.question,
        system:
          "Vous consultez le texte OFFICIEL d'une norme, propriété de l'organisation qui l'a achetée. Règles strictes :\n" +
          "- Citez le numéro de clause exact et la page.\n" +
          "- Ne reproduisez JAMAIS de longs extraits (texte protégé par le droit d'auteur) : 25 mots maximum par citation, " +
          "le reste en paraphrase.\n" +
          "- Si l'information n'y figure pas, dites-le. N'inventez rien.\n" +
          "- Français, factuel et concis.",
      });
    }

    return `Outil inconnu : ${name}`;
  }

  // ---------- Boucle agentique ----------
  const system =
    `Vous êtes l'assistant IA d'ISOproject pour le projet « ${project.name} » ` +
    `(${standardName}${standardEdition ? `, édition ${standardEdition}` : ""}).\n\n` +
    `PÉRIMÈTRE STRICT : la certification et les systèmes de management (normes ISO et équivalents), la conformité ` +
    `réglementaire liée au système de management (exigences légales françaises et européennes applicables : Code du ` +
    `travail, Code de l'environnement, RGPD…), et l'utilisation de la plateforme. Pour toute demande hors de ce ` +
    `périmètre, déclinez courtoisement en UNE phrase, sans exception.\n\n` +
    `MÉTHODE :\n` +
    `- Si la question est ambiguë ou que le contexte manque, ne répondez PAS sur le fond : posez d'abord une ou deux ` +
    `questions de clarification ciblées.\n` +
    `- Vérifiez l'état réel avant d'affirmer : utilisez vos outils (état du projet, référentiel, constats d'audit, ` +
    `documents) plutôt que de supposer.\n` +
    `- Hiérarchie des sources : 1) norme officielle déposée${officialNorm ? " (DISPONIBLE pour cette organisation)" : " (non déposée actuellement)"} ` +
    `2) référentiel en base (énoncés reformulés) 3) documents et audits du projet 4) recherche web.\n` +
    `- Pour les exigences légales françaises (ex. obligations de conformité ISO 14001, santé-sécurité ISO 45001/DUERP, ` +
    `RGPD pour ISO 27001), utilisez la recherche web en privilégiant les sources officielles : legifrance.gouv.fr, ` +
    `service-public.fr, urssaf.fr, inrs.fr, cnil.fr — et citez l'URL.\n\n` +
    `RÈGLES DE RÉPONSE :\n` +
    `- Citez TOUJOURS vos sources. Terminez chaque réponse de fond par une ligne « Sources : » (clause, document, URL).\n` +
    `- Ne reproduisez jamais de longs extraits de la norme officielle (texte protégé).\n` +
    `- N'inventez jamais une exigence, un chiffre ou une donnée de conformité. Si vous ne savez pas, dites-le.\n` +
    `- Vous ne délivrez pas de certification : seule un organisme accrédité le peut — rappelez-le si on vous demande une garantie.\n` +
    `- Français, vouvoiement, réponses précises et structurées, sans remplissage.`;

  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  const messages = [
    ...transcript.slice(-TRANSCRIPT_LIMIT).map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: String(message).trim() },
  ];

  const toolsUsed = new Set();
  let response;
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      response = await anthropic.messages
        .stream({ model: MODEL, max_tokens: 4000, system, messages, tools: TOOLS })
        .finalMessage();
      if (response.stop_reason === "refusal") throw new Error("demande refusée");

      for (const block of response.content) {
        if (block.type === "server_tool_use") toolsUsed.add("web_search");
      }
      if (response.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolsUsed.add(block.name);
        let output;
        try {
          output = await runTool(block.name, block.input || {});
        } catch (err) {
          output = `Erreur lors de l'exécution : ${err.message}`;
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 30000),
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    return res.status(502).json({ error: `L'assistant est indisponible : ${err.message}` });
  }

  const answer =
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "Je n'ai pas pu formuler de réponse — reformulez votre question.";

  // Persistance : texte seul (les échanges d'outils sont rejouables à la demande)
  const newTranscript = [
    ...transcript,
    { role: "user", content: String(message).trim() },
    { role: "assistant", content: answer },
  ].slice(-2 * TRANSCRIPT_LIMIT);
  await supabaseAdmin
    .from("chat_sessions")
    .update({ transcript: newTranscript, updated_at: new Date().toISOString() })
    .eq("id", session.id);

  return res.status(200).json({
    sessionId: session.id,
    answer,
    sources: [...toolsUsed].map((t) => TOOL_LABELS[t] || t),
  });
}
