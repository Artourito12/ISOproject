import { useEffect, useState, useRef, FormEvent } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";

interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

interface InterviewState {
  sessionId: string;
  message: string;
  transcript: TranscriptEntry[];
  missingFields: { name: string; label: string }[];
  progress: { collected: number; total: number };
  readyToGenerate: boolean;
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

export default function AssistantPage() {
  const { projectId, requirementId } = useParams<{ projectId: string; requirementId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<InterviewState | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditFindings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!requirementId) return;
    apiPost<InterviewState>("/api/generation/interview", { requirementId })
      .then(setState)
      .catch((err) => setError(err instanceof Error ? err.message : "Erreur de chargement"));
  }, [requirementId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.transcript.length, generated]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!state || !input.trim() || sending) return;
    const userMessage = input.trim();
    setInput("");
    setSending(true);
    setError(null);
    // Affichage optimiste du message utilisateur
    setState({
      ...state,
      transcript: [...state.transcript, { role: "user", content: userMessage }],
    });
    try {
      const next = await apiPost<InterviewState>("/api/generation/interview", {
        sessionId: state.sessionId,
        message: userMessage,
      });
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setSending(false);
    }
  }

  async function handleGenerate() {
    if (!state || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await apiPost<GenerateResult>("/api/generation/generate", {
        sessionId: state.sessionId,
      });
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
        setError("L'audit de conformité n'a pas pu être réalisé — relancez-le depuis la page du projet.");
      } finally {
        setAuditing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "La génération a échoué");
      setGenerating(false);
    }
  }

  if (error && !state) return <div className="page error">{error}</div>;
  if (!state) return <div className="page">Préparation de l'entretien…</div>;

  return (
    <div className="page assistant-page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Création assistée</h1>
        </div>
        <div className="completion">
          <strong>
            {state.progress.collected}/{state.progress.total}
          </strong>{" "}
          informations renseignées
        </div>
      </header>

      {state.missingFields.length > 0 && !generated && (
        <div className="card missing-fields">
          <strong>Informations encore attendues :</strong>{" "}
          {state.missingFields.map((f) => f.label).join(" · ")}
        </div>
      )}

      <div className="card chat">
        {state.transcript.map((entry, i) => (
          <div key={i} className={`bubble bubble-${entry.role}`}>
            {entry.content}
          </div>
        ))}
        {sending && <div className="bubble bubble-assistant bubble-pending">…</div>}

        {generated && (
          <div className="generated-doc">
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
                Audit de conformité réussi : le document est <strong>validé</strong> et compte dans
                la complétion de votre dossier.
              </p>
            )}

            {auditResult && !auditResult.conforme && (
              <div className="audit-findings">
                <strong>
                  Audit de conformité : {auditResult.ecarts.length} écart(s) à corriger
                </strong>
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

            <div className="encart-actions">
              <button onClick={() => navigate(`/projets/${projectId}`)} disabled={auditing}>
                Retourner au projet
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      {!generated && (
        <form className="chat-input" onSubmit={handleSend}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Votre réponse…"
            disabled={sending || generating}
            autoFocus
          />
          <button type="submit" disabled={sending || generating || !input.trim()}>
            Envoyer
          </button>
          {state.readyToGenerate && (
            <button type="button" onClick={handleGenerate} disabled={generating || sending}>
              {generating ? "Génération en cours…" : "Générer le document"}
            </button>
          )}
        </form>
      )}
    </div>
  );
}
