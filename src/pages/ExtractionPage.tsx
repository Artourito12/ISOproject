import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { uploadProjectFile } from "../lib/uploads";
import { useAuth } from "../contexts/AuthContext";

interface RequiredDoc {
  title: string;
  description: string | null;
  generation_case: number;
  source_hints: string[] | null;
}

interface ExtractedItem {
  topic: string;
  value: string;
  source_excerpt: string;
}

interface SourceExtraction {
  documentId: string;
  documentTitle: string | undefined;
  items: ExtractedItem[];
}

interface MissingInfo {
  topic: string;
  question: string;
}

interface ExtractResult {
  sessionId: string;
  extractions: SourceExtraction[];
  missing: MissingInfo[];
  responses: Record<string, string>;
}

interface GenerateResult {
  documentId: string;
  content: string;
}

interface AuditFindings {
  conforme: boolean;
  ecarts: { titre: string; description: string; clause: string | null }[];
  suggestions: string[];
  questions: string[];
}

export default function ExtractionPage() {
  const { projectId, requirementId } = useParams<{ projectId: string; requirementId: string }>();
  const navigate = useNavigate();
  const { session: authSession, profile } = useAuth();
  const [requiredDoc, setRequiredDoc] = useState<RequiredDoc | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingDocs, setPendingDocs] = useState<{ id: string; title: string }[]>([]);
  const [extractions, setExtractions] = useState<SourceExtraction[]>([]);
  const [missing, setMissing] = useState<MissingInfo[]>([]);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditFindings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!requirementId) return;
    const { data: requirement } = await supabase
      .from("document_requirements")
      .select("required_documents(title, description, generation_case, source_hints)")
      .eq("id", requirementId)
      .single();
    setRequiredDoc(
      (requirement?.required_documents as unknown as RequiredDoc) ?? null
    );

    // Session d'extraction en cours, le cas échéant
    const { data: existingSession } = await supabase
      .from("generation_sessions")
      .select("id, collected_fields")
      .eq("document_requirement_id", requirementId)
      .eq("generation_case", 2)
      .neq("status", "termine")
      .maybeSingle();

    if (existingSession) {
      setSessionId(existingSession.id);
      const fields = existingSession.collected_fields as {
        missing?: MissingInfo[];
        responses?: Record<string, string>;
      } | null;
      setMissing(fields?.missing ?? []);
      setResponses(fields?.responses ?? {});

      const { data: sources } = await supabase
        .from("extraction_sources")
        .select("document_id, extracted_data, documents(title)")
        .eq("generation_session_id", existingSession.id);
      setExtractions(
        (sources ?? []).map((s) => ({
          documentId: s.document_id,
          documentTitle: (s.documents as unknown as { title: string } | null)?.title,
          items: (s.extracted_data as { items?: ExtractedItem[] } | null)?.items ?? [],
        }))
      );
    }
    setLoading(false);
  }, [requirementId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !projectId || !profile?.organization_id || !authSession) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: { id: string; title: string }[] = [];
      for (const file of files) {
        const documentId = await uploadProjectFile({
          organizationId: profile.organization_id,
          projectId,
          file,
          userId: authSession.user.id,
        });
        uploaded.push({ id: documentId, title: file.name });
      }
      setPendingDocs((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le téléversement a échoué");
    } finally {
      setUploading(false);
    }
  }

  async function runExtraction() {
    if (!requirementId || pendingDocs.length === 0) return;
    setExtracting(true);
    setError(null);
    try {
      const result = await apiPost<ExtractResult>("/api/generation/extract", {
        requirementId,
        documentIds: pendingDocs.map((d) => d.id),
      });
      setSessionId(result.sessionId);
      setExtractions(result.extractions);
      setMissing(result.missing);
      setResponses(result.responses);
      setPendingDocs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "L'extraction a échoué");
    } finally {
      setExtracting(false);
    }
  }

  async function saveResponse(topic: string, value: string) {
    if (!sessionId) return;
    const next = { ...responses, [topic]: value };
    setResponses(next);
    await supabase
      .from("generation_sessions")
      .update({
        collected_fields: { missing, responses: next },
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
  }

  async function handleGenerate() {
    if (!sessionId || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await apiPost<GenerateResult>("/api/generation/generate", { sessionId });
      setGenerated(result);
      setGenerating(false);
      // Second audit systématique : le document généré est immédiatement contrôlé
      setAuditing(true);
      try {
        const audit = await apiPost<{ conforme: boolean; findings: AuditFindings }>(
          "/api/audits/document",
          { requirementId }
        );
        setAuditResult(audit.findings);
      } catch {
        setAuditResult(null);
        setError(
          "L'audit de conformité n'a pas pu être réalisé — relancez-le depuis la page du projet."
        );
      } finally {
        setAuditing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "La génération a échoué");
      setGenerating(false);
    }
  }

  if (loading) return <div className="page">Chargement…</div>;
  if (!requiredDoc) return <div className="page error">Encart introuvable.</div>;

  const hasExtractions = extractions.length > 0;
  const unanswered = missing.filter((m) => !(responses[m.topic] ?? "").trim());
  const readyToGenerate = hasExtractions && unanswered.length === 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Création à partir de vos documents</h1>
          <p className="encart-description">{requiredDoc.title}</p>
        </div>
      </header>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}

      {!generated && (
        <>
          <div className="card dropzone">
            <h2>1. Déposez vos documents sources</h2>
            <p className="encart-description">
              Les informations nécessaires seront extraites de vos documents, chacune avec son
              passage d'origine. Rien n'est inventé : ce que vos documents ne contiennent pas vous
              sera demandé. Documents utiles :{" "}
              {(requiredDoc.source_hints ?? []).join(", ") || "tout document pertinent"}.
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.txt,.md"
              multiple
              hidden
              onChange={handleUpload}
            />
            {pendingDocs.length > 0 && (
              <ul className="upload-messages">
                {pendingDocs.map((d) => (
                  <li key={d.id}>{d.title} — prêt pour l'extraction</li>
                ))}
              </ul>
            )}
            <div className="encart-actions" style={{ marginLeft: 0, marginTop: 12 }}>
              <button
                className={pendingDocs.length > 0 ? "secondary" : ""}
                onClick={() => inputRef.current?.click()}
                disabled={uploading || extracting}
              >
                {uploading ? "Téléversement…" : "Choisir des fichiers"}
              </button>
              {pendingDocs.length > 0 && (
                <button onClick={runExtraction} disabled={extracting || uploading}>
                  {extracting
                    ? "Extraction en cours… (environ une minute par document)"
                    : `Lancer l'extraction (${pendingDocs.length} document(s))`}
                </button>
              )}
            </div>
          </div>

          {hasExtractions && (
            <div className="card">
              <h2>2. Vérifiez les données extraites</h2>
              <p className="encart-description">
                Chaque donnée est accompagnée du passage source dont elle provient. Vous pouvez
                ajouter d'autres documents sources ci-dessus : l'extraction sera complétée.
              </p>
              {extractions.map((source) => (
                <div key={source.documentId} className="extraction-source">
                  <strong>{source.documentTitle ?? "Document source"}</strong>
                  {source.items.length === 0 ? (
                    <p className="encart-description">
                      Aucune donnée utile n'a été trouvée dans ce document.
                    </p>
                  ) : (
                    source.items.map((item, i) => (
                      <div key={i} className="extraction-item">
                        <p className="extraction-topic">
                          <strong>{item.topic}</strong> : {item.value}
                        </p>
                        <p className="extraction-excerpt">« {item.source_excerpt} »</p>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}

          {hasExtractions && missing.length > 0 && (
            <div className="card missing-fields">
              <h2>3. Complétez les informations manquantes</h2>
              <p className="encart-description">
                Ces informations sont nécessaires mais ne figurent pas dans vos documents sources.
                Elles ne seront jamais inventées : renseignez-les ou déposez un document source qui
                les contient.
              </p>
              {missing.map((m) => (
                <label key={m.topic}>
                  {m.question}
                  <input
                    defaultValue={responses[m.topic] ?? ""}
                    placeholder="Votre réponse…"
                    onBlur={(e) => void saveResponse(m.topic, e.target.value)}
                  />
                </label>
              ))}
            </div>
          )}

          {hasExtractions && (
            <div className="card">
              <h2>{missing.length > 0 ? "4" : "3"}. Générez le document</h2>
              <p className="encart-description">
                {readyToGenerate
                  ? "Toutes les informations nécessaires sont réunies. Le document sera généré exclusivement à partir des données extraites et de vos compléments, puis audité automatiquement."
                  : `${unanswered.length} information(s) manquante(s) n'ont pas encore de réponse : la génération est bloquée tant qu'elles ne sont pas renseignées.`}
              </p>
              <button onClick={handleGenerate} disabled={!readyToGenerate || generating || extracting}>
                {generating ? "Génération en cours…" : "Générer le document"}
              </button>
            </div>
          )}
        </>
      )}

      {generated && (
        <div className="card generated-doc">
          <h2>Projet de document généré</h2>
          <pre>{generated.content}</pre>

          {auditing && (
            <div className="audit-pending">
              Audit de conformité en cours… Le document est contrôlé au regard des clauses qu'il
              couvre avant d'être validé.
            </div>
          )}

          {auditResult?.conforme && (
            <p className="notice">
              Audit de conformité réussi : le document est <strong>validé</strong> et compte dans la
              complétion de votre dossier.
            </p>
          )}

          {auditResult && !auditResult.conforme && (
            <div className="audit-findings">
              <strong>Audit de conformité : {auditResult.ecarts.length} écart(s) à corriger</strong>
              <ul>
                {auditResult.ecarts.map((e, i) => (
                  <li key={i}>
                    <strong>{e.titre}</strong>
                    {e.clause && <span className="finding-clause"> — clause {e.clause}</span>}
                    <br />
                    {e.description}
                  </li>
                ))}
              </ul>
              {auditResult.questions.length > 0 && (
                <p className="finding-extra">
                  <strong>Questions de l'auditeur :</strong> {auditResult.questions.join(" · ")}
                </p>
              )}
              <p className="finding-extra">
                Retrouvez ces constats sur la page du projet pour corriger le document.
              </p>
            </div>
          )}

          <div className="encart-actions" style={{ marginLeft: 0 }}>
            <button onClick={() => navigate(`/projets/${projectId}`)} disabled={auditing}>
              Retourner au projet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
