import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";

interface GlobalAudit {
  id: string;
  status: "en_cours" | "termine" | "erreur";
  compliance_score: number | null;
  score_by_chapter: Record<string, number> | null;
  summary: string | null;
  coherence: { contradictions: Contradiction[] } | null;
  progress: { etape: string; faits: number; total: number } | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface Contradiction {
  documents: string[];
  clause: string | null;
  description: string;
  recommendation: string;
  verdict: string;
}

interface Finding {
  id: string;
  verdict: "conforme" | "nc_majeure" | "nc_mineure" | "opportunite";
  explanation: string;
  recommendation: string | null;
  criticality: number;
  status: "ouvert" | "corrige" | "reaudite";
  clauses: { number: string; title: string } | null;
  documents: { title: string } | null;
}

const VERDICT_LABELS: Record<string, string> = {
  nc_majeure: "Non-conformité majeure",
  nc_mineure: "Non-conformité mineure",
  opportunite: "Opportunité d'amélioration",
  conforme: "Conforme",
};

const PROGRESS_LABELS: Record<string, string> = {
  preparation: "Préparation de l'audit…",
  audit_documents: "Audit des documents, clause par clause…",
  coherence: "Analyse de la cohérence d'ensemble…",
  termine: "Finalisation…",
};

export default function AuditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState("");
  const [audit, setAudit] = useState<GlobalAudit | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [missingMandatory, setMissingMandatory] = useState(0);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConformes, setShowConformes] = useState(false);
  const pollRef = useRef<number | null>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: audits }, { data: requirements }] = await Promise.all([
      supabase.from("projects").select("name").eq("id", projectId).single(),
      supabase
        .from("global_audits")
        .select(
          "id, status, compliance_score, score_by_chapter, summary, coherence, progress, error_message, started_at, completed_at"
        )
        .eq("project_id", projectId)
        .order("started_at", { ascending: false })
        .limit(1),
      supabase
        .from("document_requirements")
        .select("status, required_documents(is_mandatory)")
        .eq("project_id", projectId),
    ]);

    setProjectName(project?.name ?? "");
    const latest = (audits?.[0] as GlobalAudit | undefined) ?? null;
    setAudit(latest);
    setMissingMandatory(
      (requirements ?? []).filter(
        (r) =>
          (r.required_documents as unknown as { is_mandatory: boolean })?.is_mandatory &&
          r.status !== "valide"
      ).length
    );

    if (latest && latest.status !== "en_cours") {
      const { data: rows } = await supabase
        .from("audit_findings")
        .select(
          "id, verdict, explanation, recommendation, criticality, status, clauses(number, title), documents(title)"
        )
        .eq("global_audit_id", latest.id)
        .order("criticality", { ascending: false });
      setFindings((rows as unknown as Finding[]) ?? []);
    } else {
      setFindings([]);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Suivi par polling tant que l'audit tourne (l'appel API dure plusieurs minutes).
  useEffect(() => {
    const active = launching || audit?.status === "en_cours";
    if (active && pollRef.current === null) {
      pollRef.current = window.setInterval(() => void loadData(), 4000);
    }
    if (!active && pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [launching, audit?.status, loadData]);

  function launchAudit() {
    if (!projectId) return;
    setError(null);
    setLaunching(true);
    // L'appel reste en vol pendant toute la durée de l'audit ; le suivi se fait par polling.
    apiPost("/api/audits/global", { projectId })
      .catch((err) => setError(err instanceof Error ? err.message : "Une erreur est survenue"))
      .finally(() => {
        setLaunching(false);
        void loadData();
      });
    window.setTimeout(() => void loadData(), 1500);
  }

  async function markCorrected(finding: Finding) {
    await supabase.from("audit_findings").update({ status: "corrige" }).eq("id", finding.id);
    await loadData();
  }

  if (loading) return <div className="page">Chargement…</div>;

  const running = launching || audit?.status === "en_cours";
  const grouped = {
    nc_majeure: findings.filter((f) => f.verdict === "nc_majeure"),
    nc_mineure: findings.filter((f) => f.verdict === "nc_mineure"),
    opportunite: findings.filter((f) => f.verdict === "opportunite"),
    conforme: findings.filter((f) => f.verdict === "conforme"),
  };
  const openNc = grouped.nc_majeure.concat(grouped.nc_mineure).filter((f) => f.status === "ouvert").length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Audit global de conformité</h1>
          <p className="encart-description">{projectName}</p>
        </div>
        {audit?.status === "termine" && audit.compliance_score !== null && (
          <div className="score-hero">
            <strong>{audit.compliance_score}</strong>/100
            <span>score de conformité</span>
          </div>
        )}
      </header>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}

      {running && (
        <div className="card">
          <h2>Audit en cours</h2>
          <p className="encart-description">
            {PROGRESS_LABELS[audit?.progress?.etape ?? "preparation"] ?? "Audit en cours…"} Vous
            pouvez quitter cette page : l'audit se poursuit et le résultat sera affiché ici.
          </p>
          {audit?.progress && audit.progress.total > 0 && (
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.max(4, Math.round((audit.progress.faits / audit.progress.total) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {!running && audit?.status === "erreur" && (
        <div className="card">
          <h2>L'audit n'a pas pu aboutir</h2>
          <p className="encart-description">{audit.error_message}</p>
          <button onClick={launchAudit}>Relancer l'audit</button>
        </div>
      )}

      {!running && !audit && (
        <div className="card">
          <h2>Lancer l'audit global de votre dossier</h2>
          <p className="encart-description">
            L'audit passe chaque exigence de la norme en revue : conformité de fond de chaque
            document, couverture du référentiel et cohérence d'ensemble du dossier. Chaque constat
            cite la clause concernée, le document analysé et la raison de l'écart.
          </p>
          {missingMandatory > 0 && (
            <p className="encart-description">
              {missingMandatory} document(s) obligatoire(s) ne sont pas encore validés : ils seront
              relevés comme non-conformités. Vous pouvez compléter le dossier avant de lancer
              l'audit, ou le lancer dès maintenant pour obtenir un état des lieux.
            </p>
          )}
          <button onClick={launchAudit}>Lancer l'audit global</button>
        </div>
      )}

      {!running && audit?.status === "termine" && (
        <>
          {audit.score_by_chapter && Object.keys(audit.score_by_chapter).length > 0 && (
            <div className="card">
              <h2>Conformité par chapitre</h2>
              <div className="chapter-scores">
                {Object.entries(audit.score_by_chapter).map(([chapter, score]) => (
                  <div key={chapter} className="chapter-row">
                    <span className="chapter-label">Chapitre {chapter}</span>
                    <div className="chapter-track">
                      <div
                        className={`chapter-fill ${score >= 80 ? "fill-ok" : score >= 50 ? "fill-warn" : "fill-bad"}`}
                        style={{ width: `${Math.max(2, score)}%` }}
                      />
                    </div>
                    <span className="chapter-value">{score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {audit.summary && (
            <div className="card">
              <h2>Bilan de l'auditeur</h2>
              <p className="audit-summary">{audit.summary}</p>
            </div>
          )}

          {(["nc_majeure", "nc_mineure", "opportunite"] as const).map(
            (verdict) =>
              grouped[verdict].length > 0 && (
                <div key={verdict} className="card">
                  <h2>
                    {VERDICT_LABELS[verdict]}s ({grouped[verdict].length})
                  </h2>
                  {grouped[verdict].map((finding) => (
                    <div key={finding.id} className={`finding finding-${verdict}`}>
                      <div className="finding-header">
                        <strong>
                          {finding.clauses
                            ? `Clause ${finding.clauses.number} — ${finding.clauses.title}`
                            : "Dossier"}
                        </strong>
                        {finding.status === "corrige" && (
                          <span className="badge badge-valide">Corrigé</span>
                        )}
                      </div>
                      {finding.documents && (
                        <p className="finding-doc">Document : {finding.documents.title}</p>
                      )}
                      <p>{finding.explanation}</p>
                      {finding.recommendation && (
                        <p className="finding-reco">
                          <strong>Recommandation :</strong> {finding.recommendation}
                        </p>
                      )}
                      {finding.status === "ouvert" && (
                        <div className="encart-actions">
                          <button className="secondary" onClick={() => markCorrected(finding)}>
                            Marquer comme corrigé
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
          )}

          {grouped.conforme.length > 0 && (
            <div className="card">
              <h2>Exigences conformes ({grouped.conforme.length})</h2>
              {!showConformes ? (
                <button className="link" onClick={() => setShowConformes(true)}>
                  Afficher le détail
                </button>
              ) : (
                grouped.conforme.map((finding) => (
                  <div key={finding.id} className="finding finding-conforme">
                    <strong>
                      {finding.clauses
                        ? `Clause ${finding.clauses.number} — ${finding.clauses.title}`
                        : "Dossier"}
                    </strong>
                    {finding.documents && (
                      <p className="finding-doc">Document : {finding.documents.title}</p>
                    )}
                    <p>{finding.explanation}</p>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="card">
            <h2>Et ensuite ?</h2>
            <p className="encart-description">
              {openNc > 0
                ? `${openNc} non-conformité(s) restent à corriger. Corrigez les documents concernés depuis les encarts du projet, puis relancez l'audit pour mettre à jour le score.`
                : "Aucune non-conformité ouverte : votre dossier est prêt pour la constitution finale."}
            </p>
            <p className="audit-disclaimer">
              Cet audit est une aide à la préparation de votre certification. Il ne remplace pas
              l'audit de certification, qui ne peut être réalisé que par un organisme accrédité.
            </p>
            <div className="encart-actions" style={{ marginLeft: 0 }}>
              {openNc === 0 && (
                <button onClick={() => navigate(`/projets/${projectId}/dossier`)}>
                  Constituer le dossier final
                </button>
              )}
              <button className={openNc === 0 ? "secondary" : ""} onClick={launchAudit}>
                Relancer l'audit
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
