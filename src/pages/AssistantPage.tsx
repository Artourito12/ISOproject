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

export default function AssistantPage() {
  const { projectId, requirementId } = useParams<{ projectId: string; requirementId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<InterviewState | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "La génération a échoué");
    } finally {
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
            <div className="encart-actions">
              <button onClick={() => navigate(`/projets/${projectId}`)}>
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
