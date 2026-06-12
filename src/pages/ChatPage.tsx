import { useCallback, useEffect, useRef, useState, FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
}

interface ChatResponse {
  sessionId: string;
  answer: string;
  sources: string[];
}

export default function ChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { profile } = useAuth();
  const [projectName, setProjectName] = useState("");
  const [transcript, setTranscript] = useState<ChatEntry[]>([]);
  const [lastSources, setLastSources] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    const [{ data: project }, { data: sessions }] = await Promise.all([
      supabase.from("projects").select("name").eq("id", projectId).single(),
      supabase
        .from("chat_sessions")
        .select("transcript")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    setProjectName(project?.name ?? "");
    setTranscript(((sessions?.[0]?.transcript as ChatEntry[] | undefined) ?? []) as ChatEntry[]);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, sending]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || sending || !projectId) return;
    setInput("");
    setError(null);
    setLastSources([]);
    setSending(true);
    setTranscript((prev) => [...prev, { role: "user", content: userMessage }]);
    try {
      const result = await apiPost<ChatResponse>("/api/chat/message", {
        projectId,
        message: userMessage,
      });
      setTranscript((prev) => [...prev, { role: "assistant", content: result.answer }]);
      setLastSources(result.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setSending(false);
    }
  }

  async function newConversation() {
    if (!projectId || !profile?.organization_id) return;
    await supabase
      .from("chat_sessions")
      .insert({ project_id: projectId, organization_id: profile.organization_id });
    setTranscript([]);
    setLastSources([]);
  }

  if (loading) return <div className="page">Chargement…</div>;

  return (
    <div className="page assistant-page">
      <header className="page-header">
        <div>
          <Link to={`/projets/${projectId}`} className="back-link">
            ← Retour au projet
          </Link>
          <h1>Assistant IA</h1>
          <p className="encart-description">{projectName}</p>
        </div>
        <div className="header-actions">
          <button className="secondary" onClick={newConversation} disabled={sending}>
            Nouvelle conversation
          </button>
        </div>
      </header>

      <div className="card chat">
        {transcript.length === 0 && !sending && (
          <div className="empty-state">
            <p>
              Posez vos questions sur votre certification : exigences de la norme, état de votre
              dossier, écarts d'audit, exigences légales applicables… Chaque réponse cite ses
              sources. Si votre organisation a déposé son exemplaire officiel de la norme,
              l'assistant s'y réfère en priorité.
            </p>
          </div>
        )}
        {transcript.map((entry, i) => (
          <div key={i} className={`bubble bubble-${entry.role}`}>
            {entry.content}
          </div>
        ))}
        {sending && (
          <div className="bubble bubble-assistant bubble-pending">
            L'assistant consulte vos données… (jusqu'à une minute si des documents doivent être lus)
          </div>
        )}
        {!sending && lastSources.length > 0 && (
          <p className="chat-sources">Consulté pour cette réponse : {lastSources.join(" · ")}</p>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      <form className="chat-input" onSubmit={handleSend}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Votre question…"
          disabled={sending}
          autoFocus
        />
        <button type="submit" disabled={sending || !input.trim()}>
          Envoyer
        </button>
      </form>
    </div>
  );
}
