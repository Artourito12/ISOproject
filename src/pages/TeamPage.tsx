import { useCallback, useEffect, useState, FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { apiPost } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
}

export default function TeamPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("membre");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [{ data: memberRows }, { data: invitationRows }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email, role").order("created_at"),
      supabase
        .from("invitations")
        .select("id, email, role, token, status, expires_at")
        .eq("status", "en_attente")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }),
    ]);
    setMembers((memberRows as Member[]) ?? []);
    setInvitations((invitationRows as Invitation[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function invitationLink(token: string) {
    return `${window.location.origin}/invitation/${token}`;
  }

  async function copyLink(invitation: Invitation) {
    await navigator.clipboard.writeText(invitationLink(invitation.token));
    setCopiedId(invitation.id);
    window.setTimeout(() => setCopiedId(null), 2000);
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await apiPost<{ token: string; alreadyInvited: boolean }>(
        "/api/team/invite",
        { email, role }
      );
      await navigator.clipboard.writeText(invitationLink(result.token)).catch(() => {});
      setNotice(
        (result.alreadyInvited
          ? `Une invitation était déjà en attente pour ${email}.`
          : `Invitation créée pour ${email}.`) +
          " Le lien a été copié : transmettez-le à la personne concernée."
      );
      setEmail("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setBusy(false);
    }
  }

  async function manage(body: Record<string, string>) {
    setError(null);
    setBusy(true);
    try {
      await apiPost("/api/team/manage", body);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page">Chargement…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link to="/" className="back-link">
            ← Vos projets
          </Link>
          <h1>Équipe</h1>
          <p className="encart-description">
            Les membres de votre organisation accèdent à tous ses projets de certification.
          </p>
        </div>
      </header>

      {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="notice" style={{ marginBottom: 14 }}>{notice}</div>}

      {isAdmin && (
        <form className="card" onSubmit={handleInvite}>
          <h2>Inviter un membre</h2>
          <p className="encart-description">
            Un lien d'invitation est généré : transmettez-le à la personne concernée. Il est
            valable 14 jours.
          </p>
          <div className="norm-search-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="prenom.nom@entreprise.fr"
              required
              disabled={busy}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{ width: "auto", marginTop: 0 }}
              disabled={busy}
            >
              <option value="membre">Membre</option>
              <option value="admin">Administrateur</option>
            </select>
            <button type="submit" disabled={busy || !email.trim()}>
              Inviter
            </button>
          </div>
        </form>
      )}

      <div className="card">
        <h2>Membres ({members.length})</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Membre</th>
              <th>Rôle</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.full_name || m.email || "Membre"}
                  {m.email && m.full_name && (
                    <span className="row-muted"> — {m.email}</span>
                  )}
                  {m.id === profile?.id && <span className="row-muted"> (vous)</span>}
                </td>
                <td>{m.role === "admin" ? "Administrateur" : "Membre"}</td>
                {isAdmin && (
                  <td style={{ textAlign: "right" }}>
                    {m.id !== profile?.id && (
                      <div className="encart-actions">
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            manage({
                              action: "set_role",
                              memberId: m.id,
                              role: m.role === "admin" ? "membre" : "admin",
                            })
                          }
                        >
                          {m.role === "admin" ? "Passer membre" : "Passer administrateur"}
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm("Retirer ce membre de l'organisation ?")) {
                              void manage({ action: "remove", memberId: m.id });
                            }
                          }}
                        >
                          Retirer
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {invitations.length > 0 && (
        <div className="card">
          <h2>Invitations en attente ({invitations.length})</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Rôle</th>
                <th>Expire le</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{inv.role === "admin" ? "Administrateur" : "Membre"}</td>
                  <td>
                    {new Date(inv.expires_at).toLocaleDateString("fr-FR", {
                      day: "numeric",
                      month: "long",
                    })}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <div className="encart-actions">
                      <button className="secondary" onClick={() => copyLink(inv)}>
                        {copiedId === inv.id ? "Lien copié" : "Copier le lien"}
                      </button>
                      {isAdmin && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            manage({ action: "revoke_invitation", invitationId: inv.id })
                          }
                        >
                          Révoquer
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
