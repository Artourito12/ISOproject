import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import LoginPage from "./pages/LoginPage";
import OnboardingPage from "./pages/OnboardingPage";
import DashboardPage from "./pages/DashboardPage";
import ProjectPage from "./pages/ProjectPage";
import AssistantPage from "./pages/AssistantPage";
import ExtractionPage from "./pages/ExtractionPage";
import AuditPage from "./pages/AuditPage";
import DossierPage from "./pages/DossierPage";
import AdminPage from "./pages/AdminPage";

function AppRoutes() {
  const { session, profile, loading } = useAuth();

  if (loading) return <div className="page">Chargement…</div>;
  if (!session) return <LoginPage />;
  if (!profile?.organization_id) return <OnboardingPage />;

  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/projets/:projectId" element={<ProjectPage />} />
      <Route path="/projets/:projectId/encarts/:requirementId/assistant" element={<AssistantPage />} />
      <Route path="/projets/:projectId/encarts/:requirementId/extraction" element={<ExtractionPage />} />
      <Route path="/projets/:projectId/audit" element={<AuditPage />} />
      <Route path="/projets/:projectId/dossier" element={<DossierPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
