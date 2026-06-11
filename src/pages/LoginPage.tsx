import { useState, FormEvent } from "react";
import { supabase } from "../lib/supabase";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (authError) setError(authError.message);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>ISOproject</h1>
        <p className="subtitle">Préparez et fiabilisez votre dossier de certification ISO</p>
        <form onSubmit={handleSubmit}>
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
          <button type="submit" disabled={loading}>
            {loading ? "…" : mode === "login" ? "Se connecter" : "Créer un compte"}
          </button>
        </form>
        <button
          className="link"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login"
            ? "Pas encore de compte ? Inscrivez-vous"
            : "Déjà un compte ? Connectez-vous"}
        </button>
      </div>
    </div>
  );
}
