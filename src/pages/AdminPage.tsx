import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface VersionRow {
  id: string;
  edition: string;
  referential_version: string;
  is_current: boolean;
  origin: "manual" | "ai";
  validated_at: string | null;
  published_at: string;
  standards: { code: string; name: string };
}

interface RequestRow {
  id: string;
  query: string;
  status: string;
  error_message: string | null;
  created_at: string;
  organizations: { name: string } | null;
  standards: { code: string; name: string } | null;
}

const REQUEST_STATUS: Record<string, string> = {
  en_cours: "En cours",
  traitee: "Traitée",
  erreur: "Échec",
};

export default function AdminPage() {
  const { isPlatformAdmin } = useAuth();
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<{ versions: VersionRow[]; requests: RequestRow[] }>("/api/admin/overview")
      .then((data) => {
        setVersions(data.versions);
        setRequests(data.requests);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Erreur de chargement"));
  }, []);

  useEffect(() => {
    if (isPlatformAdmin) load();
  }, [isPlatformAdmin, load]);

  async function validate(versionId: string) {
    setBusy(versionId);
    try {
      await apiPost("/api/admin/validate-standard", { versionId });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "La validation a échoué");
    } finally {
      setBusy(null);
    }
  }

  if (!isPlatformAdmin) {
    return (
      <div className="page">
        <p className="error">Cet espace est réservé aux administrateurs de la plateforme.</p>
        <Link to="/" className="back-link">
          ← Retour
        </Link>
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <Link to="/" className="back-link">
            ← Vos projets
          </Link>
          <h1>Administration de la plateforme</h1>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Catalogue des référentiels</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Norme</th>
              <th>Édition</th>
              <th>Version</th>
              <th>Origine</th>
              <th>Validation expert</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className={v.is_current ? "" : "row-muted"}>
                <td>{v.standards.name}</td>
                <td>{v.edition}</td>
                <td>
                  {v.referential_version}
                  {v.is_current && " (courante)"}
                </td>
                <td>
                  <span className={`badge ${v.origin === "ai" ? "badge-en_cours" : "badge-valide"}`}>
                    {v.origin === "ai" ? "Générée par IA" : "Manuelle"}
                  </span>
                </td>
                <td>
                  {v.validated_at ? (
                    <span className="badge badge-valide">Validée</span>
                  ) : (
                    <span className="badge badge-a_fournir">À relire</span>
                  )}
                </td>
                <td>
                  {!v.validated_at && (
                    <button onClick={() => validate(v.id)} disabled={busy === v.id}>
                      {busy === v.id ? "…" : "Marquer validée"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Demandes de normes des clients</h2>
        {requests.length === 0 && <p className="encart-description">Aucune demande pour le moment.</p>}
        <table className="admin-table">
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleDateString("fr-FR")}</td>
                <td>{r.organizations?.name ?? "—"}</td>
                <td>« {r.query} »</td>
                <td>
                  <span
                    className={`badge ${
                      r.status === "traitee"
                        ? "badge-valide"
                        : r.status === "erreur"
                          ? "badge-a_fournir"
                          : "badge-en_cours"
                    }`}
                  >
                    {REQUEST_STATUS[r.status] ?? r.status}
                  </span>
                </td>
                <td>{r.standards?.name ?? r.error_message ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
