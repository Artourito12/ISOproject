import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface RequirementRow {
  status: string;
  documents: { created_at: string } | null;
  required_documents: {
    is_mandatory: boolean;
    title: string;
    validation_rules: { max_review_age_months?: number } | null;
  } | null;
}

function isStale(row: RequirementRow): boolean {
  const months = row.required_documents?.validation_rules?.max_review_age_months;
  if (!months || row.status !== "valide" || !row.documents) return false;
  const limit = new Date(row.documents.created_at);
  limit.setMonth(limit.getMonth() + months);
  return limit < new Date();
}

interface GlobalAudit {
  id: string;
  status: string;
  compliance_score: number | null;
  score_by_chapter: Record<string, number> | null;
  completed_at: string | null;
}

interface Finding {
  id: string;
  verdict: "conforme" | "nc_majeure" | "nc_mineure" | "opportunite";
  explanation: string;
  recommendation: string | null;
  status: "ouvert" | "corrige" | "reaudite";
  clauses: { number: string; title: string } | null;
  documents: { title: string } | null;
}

interface VersionRow {
  version: number;
  created_at: string;
  documents: { title: string; origin: string } | null;
}

interface ExportRow {
  id: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  en_cours: "En cours",
  audit: "Audit",
  correction: "Correction",
  finalise: "Finalisé",
};

export default function ProjectDashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectStatus, setProjectStatus] = useState("");
  const [requirements, setRequirements] = useState<RequirementRow[]>([]);
  const [audit, setAudit] = useState<GlobalAudit | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: reqs }, { data: audits }, { data: exportRows }] =
      await Promise.all([
        supabase.from("projects").select("name, status").eq("id", projectId).single(),
        supabase
          .from("document_requirements")
          .select("status, documents(created_at), required_documents(is_mandatory, title, validation_rules)")
          .eq("project_id", projectId),
        supabase
          .from("global_audits")
          .select("id, status, compliance_score, score_by_chapter, completed_at")
          .eq("project_id", projectId)
          .eq("status", "termine")
          .order("completed_at", { ascending: false })
          .limit(1),
        supabase
          .from("dossier_exports")
          .select("id, created_at")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false }),
      ]);

    setProjectName(project?.name ?? "");
    setProjectStatus(project?.status ?? "");
    setRequirements((reqs as unknown as RequirementRow[]) ?? []);
    setExports((exportRows as ExportRow[]) ?? []);

    const lastAudit = (audits?.[0] as GlobalAudit | undefined) ?? null;
    setAudit(lastAudit);
    if (lastAudit) {
      const { data: rows } = await supabase
        .from("audit_findings")
        .select("id, verdict, explanation, recommendation, status, clauses(number, title), documents(title)")
        .eq("global_audit_id", lastAudit.id)
        .in("verdict", ["nc_majeure", "nc_mineure", "opportunite"])
        .order("criticality", { ascending: false });
      setFindings((rows as unknown as Finding[]) ?? []);
    } else {
      setFindings([]);
    }

    // Historique : dernières versions de documents du projet
    const { data: docs } = await supabase
      .from("documents")
      .select("id")
      .eq("project_id", projectId);
    const docIds = (docs ?? []).map((d) => d.id);
    if (docIds.length > 0) {
      const { data: versionRows } = await supabase
        .from("document_versions")
        .select("version, created_at, documents(title, origin)")
        .in("document_id", docIds)
        .order("created_at", { ascending: false })
        .limit(10);
      setVersions((versionRows as unknown as VersionRow[]) ?? []);
    } else {
      setVersions([]);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) return <div className="page">Chargement…</div>;

  const total = requirements.length;
  const valides = requirements.filter((r) => r.status === "valide").length;
  const fournis = requirements.filter((r) => r.status === "fourni").length;
  const mandatory = requirements.filter((r) => r.required_documents?.is_mandatory);
  const mandatoryValides = mandatory.filter((r) => r.status === "valide").length;
  const completion = total ? Math.round((valides / total) * 100) : 0;

  const openNc = findings.filter(
    (f) => f.status === "ouvert" && (f.verdict === "nc_majeure" || f.verdict === "nc_mineure")
  );
  const corrected = findings.filter(
    (f) => f.status !== "ouvert" && (f.verdict === "nc_majeure" || f.verdict === "nc_mineure")
  );
  const totalNc = openNc.length + corrected.length;
  const openOpportunites = findings.filter(
    (f) => f.verdict === "opportunite" && f.status === "ouvert"
  ).length;

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Tableau de bord</h1>
          <p className="encart-description">{projectName}</p>
        </div>
        <span className={`badge badge-${projectStatus}`}>
          {STATUS_LABELS[projectStatus] ?? projectStatus}
        </span>
      </header>

      {/* --- Indicateurs clés --- */}
      <div className="stat-grid">
        <div className="stat-tile">
          <span className="stat-value">{completion} %</span>
          <span className="stat-label">Complétion du dossier</span>
          <span className="stat-detail">
            {valides}/{total} validés
            {fournis > 0 && ` · ${fournis} en attente d'audit`}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{mandatoryValides}/{mandatory.length}</span>
          <span className="stat-label">Documents obligatoires</span>
          <span className="stat-detail">
            {mandatoryValides === mandatory.length
              ? "Tous validés"
              : `${mandatory.length - mandatoryValides} restant(s)`}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">
            {audit?.compliance_score != null ? `${audit.compliance_score}/100` : "—"}
          </span>
          <span className="stat-label">Score de conformité</span>
          <span className="stat-detail">
            {audit?.completed_at ? `Audité le ${formatDate(audit.completed_at)}` : "Aucun audit global"}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{audit ? openNc.length : "—"}</span>
          <span className="stat-label">Écarts ouverts</span>
          <span className="stat-detail">
            {audit
              ? openNc.length === 0
                ? "Aucune non-conformité ouverte"
                : `+ ${openOpportunites} opportunité(s)`
              : "Lancez un audit global"}
          </span>
        </div>
      </div>

      {/* --- Complétion --- */}
      <div className="card">
        <h2>Avancement du dossier</h2>
        <div className="progress-track" style={{ marginTop: 12 }}>
          <div className="progress-fill" style={{ width: `${Math.max(2, completion)}%` }} />
        </div>
        <p className="encart-description" style={{ marginTop: 10 }}>
          {requirements.filter((r) => r.status === "a_fournir").length} à fournir ·{" "}
          {requirements.filter((r) => r.status === "en_cours").length} en cours · {fournis} fournis
          (audit en attente) · {valides} validés
        </p>
        <div className="encart-actions" style={{ marginLeft: 0 }}>
          <button className="secondary" onClick={() => navigate(`/projets/${projectId}`)}>
            Compléter le dossier
          </button>
        </div>
      </div>

      {/* --- Conformité par chapitre --- */}
      {audit?.score_by_chapter && Object.keys(audit.score_by_chapter).length > 0 && (
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
          <div className="encart-actions" style={{ marginLeft: 0, marginTop: 12 }}>
            <button className="secondary" onClick={() => navigate(`/projets/${projectId}/audit`)}>
              Voir l'audit complet
            </button>
          </div>
        </div>
      )}

      {/* --- Écarts restants + suivi des actions correctives --- */}
      {audit && (
        <div className="card">
          <h2>Actions correctives</h2>
          {totalNc === 0 ? (
            <p className="encart-description">
              Aucune non-conformité relevée par le dernier audit global.
            </p>
          ) : (
            <>
              <p className="encart-description">
                {corrected.length}/{totalNc} non-conformité(s) traitée(s).
              </p>
              <div className="progress-track">
                <div
                  className="progress-fill fill-ok-bg"
                  style={{ width: `${Math.max(2, Math.round((corrected.length / totalNc) * 100))}%` }}
                />
              </div>
            </>
          )}
          {openNc.length > 0 && (
            <>
              <p className="encart-description" style={{ marginTop: 12 }}>
                Écarts restants, par criticité :
              </p>
              {openNc.slice(0, 5).map((f) => (
                <div key={f.id} className={`finding finding-${f.verdict}`}>
                  <strong>
                    {f.clauses ? `Clause ${f.clauses.number} — ${f.clauses.title}` : "Dossier"}
                  </strong>
                  {f.documents && <p className="finding-doc">Document : {f.documents.title}</p>}
                  <p>{f.explanation}</p>
                  {f.recommendation && (
                    <p className="finding-reco">
                      <strong>Recommandation :</strong> {f.recommendation}
                    </p>
                  )}
                </div>
              ))}
              {openNc.length > 5 && (
                <p className="encart-description" style={{ marginTop: 8 }}>
                  {openNc.length - 5} autre(s) écart(s) sur la page de l'audit.
                </p>
              )}
              <div className="encart-actions" style={{ marginLeft: 0, marginTop: 12 }}>
                <button className="secondary" onClick={() => navigate(`/projets/${projectId}/audit`)}>
                  Gérer les écarts
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* --- Cycle de vie : documents à revoir --- */}
      {requirements.some(isStale) && (
        <div className="card">
          <h2>Documents à revoir ({requirements.filter(isStale).length})</h2>
          <p className="encart-description">
            Ces documents validés dépassent l'âge maximal de revue prévu par le référentiel.
            Déposez une version revue depuis l'encart concerné pour maintenir la conformité.
          </p>
          <ul className="upload-messages">
            {requirements.filter(isStale).map((r, i) => (
              <li key={i}>
                {r.required_documents?.title} — fourni le{" "}
                {r.documents ? formatDate(r.documents.created_at) : "—"} (revue exigée tous les{" "}
                {r.required_documents?.validation_rules?.max_review_age_months} mois)
              </li>
            ))}
          </ul>
          <div className="encart-actions" style={{ marginLeft: 0 }}>
            <button className="secondary" onClick={() => navigate(`/projets/${projectId}`)}>
              Mettre à jour les documents
            </button>
          </div>
        </div>
      )}

      {/* --- Historique et versioning --- */}
      <div className="card">
        <h2>Historique des documents</h2>
        {versions.length === 0 ? (
          <p className="encart-description">Aucun document pour le moment.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Version</th>
                <th>Origine</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v, i) => (
                <tr key={i}>
                  <td>{v.documents?.title ?? "—"}</td>
                  <td>v{v.version}</td>
                  <td>{v.documents?.origin === "generated" ? "Généré par l'IA" : "Déposé"}</td>
                  <td>{formatDate(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {exports.length > 0 && (
          <p className="encart-description" style={{ marginTop: 10 }}>
            {exports.length} dossier(s) constitué(s), le dernier le {formatDate(exports[0].created_at)}.{" "}
            <Link to={`/projets/${projectId}/dossier`}>Voir les dossiers</Link>
          </p>
        )}
      </div>

      {/* --- Zone de danger (RGPD) --- */}
      {profile?.role === "admin" && (
        <div className="card danger-zone">
          <h2>Suppression du projet</h2>
          <p className="encart-description">
            Supprime définitivement le projet, tous ses documents (déposés et générés), ses audits
            et ses dossiers constitués. Cette action est irréversible.
          </p>
          {deleteError && <p className="error">{deleteError}</p>}
          <button
            className="danger"
            disabled={deleting}
            onClick={async () => {
              const typed = window.prompt(
                `Pour confirmer la suppression définitive, saisissez le nom du projet : « ${projectName} »`
              );
              if (typed !== projectName) {
                if (typed !== null) setDeleteError("Le nom saisi ne correspond pas : suppression annulée.");
                return;
              }
              setDeleting(true);
              setDeleteError(null);
              try {
                await apiPost("/api/projects/delete", { projectId });
                navigate("/", { replace: true });
              } catch (err) {
                setDeleteError(err instanceof Error ? err.message : "La suppression a échoué");
                setDeleting(false);
              }
            }}
          >
            {deleting ? "Suppression…" : "Supprimer définitivement ce projet"}
          </button>
        </div>
      )}
    </div>
  );
}
