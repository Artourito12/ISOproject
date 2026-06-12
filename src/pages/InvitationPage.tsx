import { useEffect, useRef, useState, FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface AcceptResult {
  organizationId: string;
  organizationName?: string;
}

export default function InvitationPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { session, profile, loading, refreshProfile } = useAuth();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const acceptedRef = useRef(false);

  // Dès qu'une session existe (connexion, inscription ou déjà connecté),
  // on tente d'accepter l'invitation.
  useEffect(() => {
    if (loading || !session || !token || acceptedRef.current) return;
    if (profile?.organization_id) return; // géré dans le rendu
    acceptedRef.current = true;
    setAccepting(true);
    apiPost<AcceptResult>("/api/team/accept", {
      invitationToken: token,
      fullName: fullName || undefined,
    })
      .then(async (result) => {
        await refreshProfile();
        navigate("/", { replace: true });
        void result;
      })
      .catch((err) => {
        acceptedRef.current = false;
        setError(err instanceof Error ? err.message : "L'invitation n'a pas pu être acceptée");
      })
      .finally(() => setAccepting(false));
  }, [loading, session, profile?.organization_id, token, fullName, navigate, refreshProfile]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: authError } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (authError) setError(authError.message);
    // L'acceptation se déclenche via le useEffect quand la session arrive.
  }

  if (loading) return <div className="auth-page">Chargement…</div>;

  if (session && profile?.organization_id) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Invitation</h1>
          <p className="subtitle">
            Votre compte appartient déjà à une organisation : cette invitation ne peut pas être
            acceptée avec ce compte.
          </p>
          <button onClick={() => navigate("/")}>Retourner à vos projets</button>
        </div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Invitation</h1>
          <p className="subtitle">
            {accepting ? "Rattachement à l'organisation en cours…" : ""}
          </p>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Vous êtes invité</h1>
        <p className="subtitle">
          Créez votre compte (ou connectez-vous) pour rejoindre l'organisation qui vous a invité.
        </p>
        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <label>
              Votre nom complet
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
          )}
          <label>
            Adresse email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Mot de passe
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Se connecter et rejoindre" : "Créer mon compte et rejoindre"}
          </button>
        </form>
        <button className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login"
            ? "Pas encore de compte ? Inscrivez-vous"
            : "Déjà un compte ? Connectez-vous"}
        </button>
      </div>
    </div>
  );
}
