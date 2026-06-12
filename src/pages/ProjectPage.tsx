import { useEffect, useState, useCallback, useRef, ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { uploadProjectFile } from "../lib/uploads";
import { useAuth } from "../contexts/AuthContext";

interface Encart {
  id: string;
  status: string;
  classification_confidence: number | null;
  document_id: string | null;
  documents: { title: string } | null;
  required_documents: {
    key: string;
    title: string;
    description: string | null;
    is_mandatory: boolean;
    generation_case: number;
    evidence_type: string;
  };
}

interface ProjectDocument {
  id: string;
  title: string;
}

interface AuditFindings {
  conforme: boolean;
  ecarts: { titre: string; description: string; clause: string | null }[];
  suggestions: string[];
  questions: string[];
}

interface DocumentAudit {
  document_id: string;
  status: "en_cours" | "conforme" | "non_conforme";
  findings: AuditFindings | null;
  created_at: string;
}

interface ClassifyResult {
  matched: boolean;
  requirementId?: string;
  matchedKey?: string;
  confidence?: number;
  autoConfirmed?: boolean;
  needsHumanConfirmation?: boolean;
  reasoning?: string;
  reason?: string;
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
  const navigate = useNavigate();
  const { session, profile } = useAuth();
  const [projectName, setProjectName] = useState("");
  const [encarts, setEncarts] = useState<Encart[]>([]);
  const [unattachedDocs, setUnattachedDocs] = useState<ProjectDocument[]>([]);
  const [audits, setAudits] = useState<Record<string, DocumentAudit>>({});
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [encartBusy, setEncartBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const globalInputRef = useRef<HTMLInputElement>(null);
  const encartInputRef = useRef<HTMLInputElement>(null);
  const encartTargetRef = useRef<Encart | null>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: requirements }, { data: docs }] = await Promise.all([
      supabase.from("projects").select("name").eq("id", projectId).single(),
      supabase
        .from("document_requirements")
        .select(
          "id, status, classification_confidence, document_id, documents(title), required_documents(key, title, description, is_mandatory, generation_case, evidence_type)"
        )
        .eq("project_id", projectId),
      supabase.from("documents").select("id, title").eq("project_id", projectId),
    ]);
    const loadedEncarts = (requirements as unknown as Encart[]) ?? [];
    setProjectName(project?.name ?? "");
    setEncarts(loadedEncarts);

    const attachedIds = new Set(loadedEncarts.map((e) => e.document_id).filter(Boolean));
    // Les documents sources déposés pour une extraction (Cas 2) ne sont pas des
    // pièces du dossier : on ne les propose pas au rattachement manuel.
    const { data: sourceRows } = await supabase.from("extraction_sources").select("document_id");
    const sourceIds = new Set((sourceRows ?? []).map((s) => s.document_id));
    setUnattachedDocs(
      (docs ?? []).filter((d) => !attachedIds.has(d.id) && !sourceIds.has(d.id))
    );

    // Dernier audit ciblé par document (le plus récent gagne)
    const docIds = (docs ?? []).map((d) => d.id);
    if (docIds.length > 0) {
      const { data: auditRows } = await supabase
        .from("document_audits")
        .select("document_id, status, findings, created_at")
        .in("document_id", docIds)
        .order("created_at", { ascending: false });
      const latest: Record<string, DocumentAudit> = {};
      for (const a of (auditRows as DocumentAudit[]) ?? []) {
        if (!latest[a.document_id]) latest[a.document_id] = a;
      }
      setAudits(latest);
    } else {
      setAudits({});
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function pushMessage(text: string) {
    setMessages((prev) => [...prev, text]);
  }

  // Second audit systématique : déclenché après chaque passage à « Fourni ».
  async function runAudit(requirementId: string): Promise<AuditFindings | null> {
    setAuditingId(requirementId);
    try {
      const result = await apiPost<{ conforme: boolean; findings: AuditFindings }>(
        "/api/audits/document",
        { requirementId }
      );
      return result.findings;
    } catch (err) {
      pushMessage(
        `L'audit de conformité n'a pas pu être réalisé : ${err instanceof Error ? err.message : "erreur"}. Vous pouvez le relancer depuis l'encart.`
      );
      return null;
    } finally {
      setAuditingId(null);
      await loadData();
    }
  }

  // --- Dépôt global : l'IA reconnaît et classe chaque fichier ---
  async function handleGlobalUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !projectId || !profile?.organization_id || !session) return;

    setUploading(true);
    setMessages([]);
    for (const file of files) {
      try {
        const documentId = await uploadProjectFile({
          organizationId: profile.organization_id,
          projectId,
          file,
          userId: session.user.id,
        });
        const result = await apiPost<ClassifyResult>("/api/documents/classify", { documentId });
        if (result.matched && result.autoConfirmed && result.requirementId) {
          pushMessage(`« ${file.name} » a été reconnu et rattaché (${result.matchedKey}). Audit de conformité en cours…`);
          const findings = await runAudit(result.requirementId);
          if (findings) {
            pushMessage(
              findings.conforme
                ? `« ${file.name} » : conforme — document validé.`
                : `« ${file.name} » : ${findings.ecarts.length} écart(s) constaté(s) — consultez l'encart concerné.`
            );
          }
        } else if (result.matched && result.needsHumanConfirmation) {
          pushMessage(
            `« ${file.name} » semble correspondre à « ${result.matchedKey} » — confirmez le rattachement dans l'encart concerné.`
          );
        } else {
          pushMessage(
            `« ${file.name} » n'a pas été reconnu. Vous pouvez le rattacher manuellement ci-dessous.`
          );
        }
      } catch (err) {
        pushMessage(
          `« ${file.name} » : ${err instanceof Error ? err.message : "une erreur est survenue"}.`
        );
      }
    }
    await loadData();
    setUploading(false);
  }

  // --- Dépôt direct dans un encart précis (pas de classification nécessaire) ---
  function openEncartUpload(encart: Encart) {
    encartTargetRef.current = encart;
    encartInputRef.current?.click();
  }

  async function handleEncartUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const encart = encartTargetRef.current;
    if (!file || !encart || !projectId || !profile?.organization_id || !session) return;

    setEncartBusy(encart.id);
    try {
      const documentId = await uploadProjectFile({
        organizationId: profile.organization_id,
        projectId,
        file,
        userId: session.user.id,
      });
      await supabase
        .from("document_requirements")
        .update({
          document_id: documentId,
          status: "fourni",
          classification_confirmed_by: session.user.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", encart.id);
      await loadData();
      setEncartBusy(null);
      await runAudit(encart.id);
      return;
    } catch (err) {
      pushMessage(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setEncartBusy(null);
    }
  }

  // --- Confirmation humaine d'un classement incertain ---
  async function confirmClassification(encart: Encart) {
    if (!session) return;
    setEncartBusy(encart.id);
    await supabase
      .from("document_requirements")
      .update({
        status: "fourni",
        classification_confirmed_by: session.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", encart.id);
    await loadData();
    setEncartBusy(null);
    await runAudit(encart.id);
  }

  async function rejectClassification(encart: Encart) {
    setEncartBusy(encart.id);
    await supabase
      .from("document_requirements")
      .update({
        document_id: null,
        status: "a_fournir",
        classification_confidence: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", encart.id);
    await loadData();
    setEncartBusy(null);
  }

  // --- Rattachement manuel d'un document non reconnu ---
  async function attachManually(documentId: string, encartId: string) {
    if (!session || !encartId) return;
    await supabase
      .from("document_requirements")
      .update({
        document_id: documentId,
        status: "fourni",
        classification_confirmed_by: session.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", encartId);
    await loadData();
    await runAudit(encartId);
  }

  const total = encarts.length;
  const done = encarts.filter((e) => e.status === "valide").length;
  const openEncarts = encarts.filter((e) => !e.document_id);

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
        <div className="header-actions">
          <div className="completion">
            <strong>
              {done}/{total}
            </strong>{" "}
            documents validés
          </div>
          <button
            className="secondary"
            onClick={() => navigate(`/projets/${projectId}/audit`)}
            title="Passez chaque exigence de la norme en revue"
          >
            Audit global
          </button>
          <button
            className="secondary"
            onClick={() => navigate(`/projets/${projectId}/dossier`)}
            title="Assemblez vos documents validés en un dossier prêt à transmettre"
          >
            Dossier final
          </button>
        </div>
      </header>

      <div className="card dropzone">
        <h2>Déposez vos documents existants</h2>
        <p className="encart-description">
          Déposez les documents que vous possédez déjà : ils seront reconnus et rattachés
          automatiquement aux exigences correspondantes. Format recommandé : PDF.
        </p>
        <input
          ref={globalInputRef}
          type="file"
          accept=".pdf,.txt,.md"
          multiple
          hidden
          onChange={handleGlobalUpload}
        />
        <button onClick={() => globalInputRef.current?.click()} disabled={uploading}>
          {uploading ? "Analyse en cours…" : "Choisir des fichiers"}
        </button>
        {messages.length > 0 && (
          <ul className="upload-messages">
            {messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </div>

      {unattachedDocs.length > 0 && (
        <div className="card unattached">
          <h2>Documents non rattachés</h2>
          <p className="encart-description">
            Ces documents n'ont pas pu être reconnus automatiquement. Indiquez à quelle exigence
            chacun correspond.
          </p>
          {unattachedDocs.map((doc) => (
            <div key={doc.id} className="unattached-row">
              <span>{doc.title}</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void attachManually(doc.id, e.target.value);
                }}
              >
                <option value="" disabled>
                  Rattacher à…
                </option>
                {openEncarts.map((enc) => (
                  <option key={enc.id} value={enc.id}>
                    {enc.required_documents.title}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <input ref={encartInputRef} type="file" accept=".pdf,.txt,.md" hidden onChange={handleEncartUpload} />

      <div className="encart-list">
        {encarts.map((encart) => {
          const doc = encart.required_documents;
          const busy = encartBusy === encart.id;
          const awaitingConfirmation = encart.status === "en_cours" && encart.document_id;
          const audit = encart.document_id ? audits[encart.document_id] : undefined;
          const auditing = auditingId === encart.id;
          const showFindings =
            encart.status === "fourni" && audit?.status === "non_conforme" && audit.findings;
          return (
            <div key={encart.id} className={`card encart encart-${encart.status}`}>
              <div className="encart-header">
                <h2>{doc.title}</h2>
                <span className={`badge badge-${encart.status}`}>
                  {STATUS_LABELS[encart.status] ?? encart.status}
                </span>
              </div>
              <p className="encart-description">{doc.description}</p>

              {encart.documents && !awaitingConfirmation && (
                <p className="attached-doc">Document fourni : {encart.documents.title}</p>
              )}

              {auditing && (
                <div className="audit-pending">
                  Audit de conformité en cours… (environ une minute)
                </div>
              )}

              {showFindings && !auditing && audit?.findings && (
                <div className="audit-findings">
                  <strong>
                    Audit de conformité : {audit.findings.ecarts.length} écart(s) à corriger
                  </strong>
                  <ul>
                    {audit.findings.ecarts.map((e, i) => (
                      <li key={i}>
                        <strong>{e.titre}</strong>
                        {e.clause && <span className="finding-clause"> — clause {e.clause}</span>}
                        <br />
                        {e.description}
                      </li>
                    ))}
                  </ul>
                  {audit.findings.suggestions.length > 0 && (
                    <p className="finding-extra">
                      <strong>Suggestions :</strong> {audit.findings.suggestions.join(" · ")}
                    </p>
                  )}
                  {audit.findings.questions.length > 0 && (
                    <p className="finding-extra">
                      <strong>Questions de l'auditeur :</strong>{" "}
                      {audit.findings.questions.join(" · ")}
                    </p>
                  )}
                  <div className="encart-actions">
                    <button onClick={() => openEncartUpload(encart)} disabled={busy || uploading}>
                      Déposer une version corrigée
                    </button>
                    <button
                      className="secondary"
                      onClick={() => runAudit(encart.id)}
                      disabled={busy || uploading}
                    >
                      Relancer l'audit
                    </button>
                  </div>
                </div>
              )}

              {encart.status === "fourni" && !audit && !auditing && !awaitingConfirmation && (
                <div className="encart-actions" style={{ marginBottom: "0.75rem" }}>
                  <button onClick={() => runAudit(encart.id)} disabled={busy || uploading}>
                    Lancer l'audit de conformité
                  </button>
                </div>
              )}

              {awaitingConfirmation && (
                <div className="confirmation-box">
                  <p>
                    Ce document (« {encart.documents?.title} ») semble être votre{" "}
                    <strong>{doc.title.toLowerCase()}</strong>
                    {encart.classification_confidence !== null &&
                      ` (confiance : ${Math.round(encart.classification_confidence * 100)} %)`}
                    . Confirmez-vous ?
                  </p>
                  <div className="encart-actions">
                    <button onClick={() => confirmClassification(encart)} disabled={busy}>
                      Oui, c'est bien ce document
                    </button>
                    <button
                      className="secondary"
                      onClick={() => rejectClassification(encart)}
                      disabled={busy}
                    >
                      Non, détacher
                    </button>
                  </div>
                </div>
              )}

              <div className="encart-footer">
                <span className="encart-case">{CASE_LABELS[doc.generation_case]}</span>
                {!doc.is_mandatory && <span className="badge badge-optionnel">Recommandé</span>}
                <div className="encart-actions">
                  {!encart.document_id && (
                    <button onClick={() => openEncartUpload(encart)} disabled={busy || uploading}>
                      {busy ? "Téléversement…" : "Déposer un document"}
                    </button>
                  )}
                  {doc.generation_case === 1 && !encart.document_id && (
                    <button
                      onClick={() =>
                        navigate(`/projets/${projectId}/encarts/${encart.id}/assistant`)
                      }
                      disabled={busy || uploading}
                    >
                      Créer avec l'assistant
                    </button>
                  )}
                  {doc.generation_case === 2 && !encart.document_id && (
                    <button
                      onClick={() =>
                        navigate(`/projets/${projectId}/encarts/${encart.id}/extraction`)
                      }
                      disabled={busy || uploading}
                    >
                      Créer à partir de vos documents
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
