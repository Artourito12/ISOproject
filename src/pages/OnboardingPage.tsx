import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

export default function OnboardingPage() {
  const [organizationName, setOrganizationName] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { refreshProfile } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/onboarding/create-organization", { organizationName, fullName });
      await refreshProfile();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Bienvenue</h1>
        <p className="subtitle">Créez votre organisation pour commencer</p>
        <form onSubmit={handleSubmit}>
          <label>
            Nom de votre entreprise
            <input
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
            />
          </label>
          <label>
            Votre nom complet
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "…" : "Créer mon espace"}
          </button>
        </form>
      </div>
    </div>
  );
}
