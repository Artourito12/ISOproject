import { useEffect, useState, FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";

interface Project {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface Standard {
  code: string;
  name: string;
}

const STATUS_LABELS: Record<string, string> = {
  en_cours: "En cours",
  audit: "Audit",
  correction: "Correction",
  finalise: "Finalisé",
};

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [standards, setStandards] = useState<Standard[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [standardCode, setStandardCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadData() {
    const [{ data: projectsData }, { data: standardsData }] = await Promise.all([
      supabase.from("projects").select("id, name, status, created_at").order("created_at", { ascending: false }),
      supabase.from("standards").select("code, name").eq("is_active", true),
    ]);
    setProjects(projectsData ?? []);
    setStandards(standardsData ?? []);
    if (standardsData?.length && !standardCode) setStandardCode(standardsData[0].code);
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/projects/create", { name, standardCode });
      setName("");
      setShowForm(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Vos projets de certification</h1>
        <div className="header-actions">
          <button onClick={() => setShowForm(!showForm)}>
            {showForm ? "Annuler" : "Nouveau projet"}
          </button>
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Se déconnecter
          </button>
        </div>
      </header>

      {showForm && (
        <form className="card form-inline" onSubmit={handleCreate}>
          <label>
            Nom du projet
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Certification ISO 9001 — 2026"
              required
            />
          </label>
          <label>
            Norme visée
            <select value={standardCode} onChange={(e) => setStandardCode(e.target.value)} required>
              {standards.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Création…" : "Créer le projet"}
          </button>
        </form>
      )}

      {projects.length === 0 && !showForm && (
        <div className="card empty-state">
          <p>
            Vous n'avez pas encore de projet. Créez votre premier projet de certification : la
            plateforme vous indiquera précisément les documents à fournir.
          </p>
        </div>
      )}

      <div className="project-list">
        {projects.map((p) => (
          <Link to={`/projets/${p.id}`} key={p.id} className="card project-card">
            <h2>{p.name}</h2>
            <span className={`badge badge-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
