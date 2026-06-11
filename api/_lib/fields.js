// Validation de complétude des champs d'un field_schema de référentiel.
// C'est CE code qui applique la règle d'or (pas de document à trous),
// jamais la confiance dans le modèle.
export function missingRequiredFields(fieldSchema, collected) {
  const missing = [];
  for (const [name, def] of Object.entries(fieldSchema || {})) {
    if (!def.required) continue;
    const value = collected?.[name];
    if (value === undefined || value === null || value === "") missing.push(name);
    else if (Array.isArray(value) && value.length < (def.minItems || 1)) missing.push(name);
  }
  return missing;
}
