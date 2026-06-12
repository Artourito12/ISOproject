import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";

interface RequirementRow {
  status: string;
  required_documents: { title: string; is_mandatory: boolean } | null;
}

interface DossierExport {
  id: string;
  storage_path: string;
  created_at: string;
  global_audit_id: string | null;
  correspondence_table: CorrespondenceRow[] | null;
}

interface CorrespondenceRow {
  clause_number: string;
  clause_title: string;
  required_title: string;
  is_mandatory: boolean;
  document_title: string | null;
  status: "valide" | "non_fourni";
}

interface ExportResult {
  exportId: string;
  documentsCount: number;
  complianceScore: number | null;
}

export default function DossierPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("");
  const [missingMandatory, setMissingMandatory] = useState<string[]>([]);
  const [validatedCount, setValidatedCount] = useState(0);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [openNc, setOpenNc] = useState(0);
  const [exports, setExports] = useState<DossierExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: requirements }, { data: audits }, { data: exportRows }] =
      await Promise.all([
        supabase.from("projects").select("name").eq("id", projectId).single(),
        supabase
          .from("document_requirements")
          .select("status, required_documents(title, is_mandatory)")
          .eq("project_id", projectId),
        supabase
          .from("global_audits")
          .select("id, compliance_score")
          .eq("project_id", projectId)
          .eq("status", "termine")
          .order("completed_at", { ascending: false })
          .limit(1),
        supabase
          .from("dossier_exports")
          .select("id, storage_path, created_at, global_audit_id, correspondence_table")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false }),
      ]);

    setProjectName(project?.name ?? "");
    const rows = (requirements as unknown as RequirementRow[]) ?? [];
    setMissingMandatory(
      rows
        .filter((r) => r.required_documents?.is_mandatory && r.status !== "valide")
        .map((r) => r.required_documents?.title ?? "")
    );
    setValidatedCount(rows.filter((r) => r.status === "valide").length);

    const lastAudit = audits?.[0] ?? null;
    setLastScore(lastAudit?.compliance_score ?? null);
    if (lastAudit) {
      const { count } = await supabase
        .from("audit_findings")
        .select("id", { count: "exact", head: true })
        .eq("global_audit_id", lastAudit.id)
        .eq("status", "ouvert")
        .in("verdict", ["nc_majeure", "nc_mineure"]);
      setOpenNc(count ?? 0);
    } else {
      setOpenNc(0);
    }
    setExports((exportRows as DossierExport[]) ?? []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function buildDossier() {
    if (!projectId) return;
    setError(null);
    setNotice(null);
    setBuilding(true);
    try {
      const result = await apiPost<ExportResult>("/api/dossier/export", { projectId });
      setNotice(
        `Votre dossier a été constitué : ${result.documentsCount} document(s) assemblés, ` +
          `avec sommaire et table de correspondance. Vous pouvez le télécharger ci-dessous.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setBuilding(false);
      await loadData();
    }
  }

  async function downloadExport(item: DossierExport) {
    const { data, error: signError } = await supabase.storage
      .from("documents")
      .createSignedUrl(item.storage_path, 3600);
    if (signError || !data?.signedUrl) {
      setError("Le lien de téléchargement n'a pas pu être créé. Réessayez.");
      return;
    }
    window.open(data.signedUrl, "_blank");
  }

  if (loading) return <div className="page">Chargement…</div>;

  const ready = missingMandatory.length === 0;
  const latestExport = exports[0] ?? null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Dossier final</h1>
          <p className="encart-description">{projectName}</p>
        </div>
        {lastScore !== null && (
          <div className="score-hero">
            <strong>{lastScore}</strong>/100
            <span>dernier audit global</span>
          </div>
        )}
      </header>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="card">
        <h2>Constitution du dossier</h2>
        <p className="encart-description">
          Le dossier final assemble tous vos documents validés, classés par chapitre de la norme,
          accompagnés d'un sommaire et de la table de correspondance exigence ↔ preuve, dans une
          archive prête à transmettre à votre organisme certificateur.
        </p>

        {!ready && (
          <>
            <p className="encart-description">
              <strong>{missingMandatory.length} document(s) obligatoire(s)</strong> ne sont pas
              encore validés. Complétez-les avant de constituer le dossier :
            </p>
            <ul className="upload-messages">
              {missingMandatory.map((title, i) => (
                <li key={i}>{title}</li>
              ))}
            </ul>
          </>
        )}

        {ready && openNc > 0 && (
          <p className="encart-description">
            Attention : {openNc} non-conformité(s) du dernier audit global restent ouvertes. Vous
            pouvez constituer le dossier, mais il est recommandé de les corriger d'abord.
          </p>
        )}

        {ready && lastScore === null && (
          <p className="encart-description">
            Aucun audit global n'a encore été réalisé. Il est recommandé d'auditer votre dossier
            avant de le constituer.
          </p>
        )}

        <button onClick={buildDossier} disabled={!ready || building}>
          {building
            ? "Constitution en cours…"
            : ready
              ? "Constituer le dossier final"
              : `Complétez d'abord le dossier (${validatedCount} validé(s))`}
        </button>
        <p className="audit-disclaimer">
          Le dossier constitué est une aide à la préparation : la certification ne peut être
          délivrée que par un organisme accrédité, à l'issue de son propre audit.
        </p>
      </div>

      {exports.length > 0 && (
        <div className="card">
          <h2>Dossiers constitués</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Audit joint</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {exports.map((item) => (
                <tr key={item.id}>
                  <td>
                    {new Date(item.created_at).toLocaleDateString("fr-FR", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className={item.global_audit_id ? "" : "row-muted"}>
                    {item.global_audit_id ? "Oui" : "Aucun"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="secondary" onClick={() => downloadExport(item)}>
                      Télécharger l'archive
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {latestExport?.correspondence_table && latestExport.correspondence_table.length > 0 && (
        <div className="card">
          <h2>Table de correspondance exigence ↔ preuve</h2>
          <p className="encart-description">
            Telle qu'incluse dans le dernier dossier constitué (correspondance.pdf).
          </p>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Clause</th>
                <th>Exigence documentaire</th>
                <th>Preuve fournie</th>
              </tr>
            </thead>
            <tbody>
              {latestExport.correspondence_table.map((row, i) => (
                <tr key={i}>
                  <td>
                    {row.clause_number} — {row.clause_title}
                  </td>
                  <td>{row.required_title}</td>
                  <td className={row.status === "valide" ? "" : "row-muted"}>
                    {row.status === "valide"
                      ? row.document_title
                      : row.is_mandatory
                        ? "Non fourni"
                        : "Non fourni (recommandé)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
