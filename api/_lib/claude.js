// Client Claude partagé par les fonctions api/*.
// Conventions du projet :
//  - sorties structurées (output_config.format + JSON Schema) pour tout ce qui est machine ;
//  - adaptive thinking pour les tâches d'audit ;
//  - l'exigence de la clause est TOUJOURS injectée depuis la base, jamais supposée connue.
import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODEL = "claude-opus-4-8";

// Appel avec sortie structurée. `schema` est un JSON Schema (objet racine,
// additionalProperties: false sur chaque objet).
export async function callStructured({ system, messages, schema, thinking = false, maxTokens = 16000 }) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { format: { type: "json_schema", schema } },
  };
  if (thinking) params.thinking = { type: "adaptive" };

  const response = await anthropic.messages.create(params);

  if (response.stop_reason === "refusal") {
    throw new Error("Requête refusée par le modèle");
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Réponse sans contenu texte");
  return JSON.parse(text);
}
