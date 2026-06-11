import { useEffect, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface Encart {
  id: string;
  status: string;
  classification_confidence: number | null;
  required_documents: {
    key: string;
    title: string;
    description: string | null;
    is_mandatory: boolean;
    generation_case: number;
    evidence_type: string;
  };
}

const STATUS_LABELS: Record<string, string> = {
  a_fournir: "À fournir",
  en_cours: "En cours",
  fourni: "Fourni",
  valide: "Validé",
};

const CASE_LABELS: Record<number, string> = {
  1: "Création assistée par entretien",
  2: "Création à partir de vos documents",
  3: "Dépôt direct uniquement",
};

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [projectName, setProjectName] = useState("");
  const [encarts, setEncarts] = useState<Encart[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: requirements }] = await Promise.all([
      supabase.from("projects").select("name").eq("id", projectId).single(),
      supabase
        .from("document_requirements")
        .select(
          "id, status, classification_confidence, required_documents(key, title, description, is_mandatory, generation_case, evidence_type)"
        )
        .eq("project_id", projectId),
    ]);
    setProjectName(project?.name ?? "");
    setEncarts((requirements as unknown as Encart[]) ?? []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const total = encarts.length;
  const done = encarts.filter((e) => e.status === "valide").length;

  if (loading) return <div className="page">Chargement…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to="/" className="back-link">
            ← Vos projets
          </Link>
          <h1>{projectName}</h1>
        </div>
        <div className="completion">
          <strong>
            {done}/{total}
          </strong>{" "}
          documents validés
        </div>
      </header>

      <div className="encart-list">
        {encarts.map((encart) => {
          const doc = encart.required_documents;
          return (
            <div key={encart.id} className={`card encart encart-${encart.status}`}>
              <div className="encart-header">
                <h2>{doc.title}</h2>
                <span className={`badge badge-${encart.status}`}>
                  {STATUS_LABELS[encart.status] ?? encart.status}
                </span>
              </div>
              <p className="encart-description">{doc.description}</p>
              <div className="encart-footer">
                <span className="encart-case">{CASE_LABELS[doc.generation_case]}</span>
                {!doc.is_mandatory && <span className="badge badge-optionnel">Recommandé</span>}
                <div className="encart-actions">
                  <button disabled title="Bientôt disponible">
                    Déposer un document
                  </button>
                  {doc.generation_case !== 3 && (
                    <button disabled title="Bientôt disponible">
                      Créer avec l'assistant
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
