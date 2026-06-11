import { supabase } from "./supabase";

// Appel des fonctions api/* avec le token de session courant.
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `Erreur ${response.status}`);
  }
  return json as T;
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `Erreur ${response.status}`);
  }
  return json as T;
}
