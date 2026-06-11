// Charge un référentiel de norme (referentiels/<code>/) en base Supabase.
// Usage : node scripts/seed-referentiel.mjs iso9001
// Requiert SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans l'environnement (ou .env).

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Lecture .env minimaliste (pas de dépendance dotenv)
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const code = process.argv[2];
if (!code) {
  console.error("Usage : node scripts/seed-referentiel.mjs <code>   (ex. iso9001)");
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const dir = join(root, "referentiels", code);
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const clauses = JSON.parse(readFileSync(join(dir, "clauses.json"), "utf8"));
const documents = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8"));

async function fail(step, error) {
  console.error(`Échec (${step}) :`, error.message);
  process.exit(1);
}

console.log(`Seed du référentiel ${meta.code} ${meta.edition} v${meta.referential_version}…`);

// 1. Norme
const { data: standard, error: e1 } = await supabase
  .from("standards")
  .upsert(
    { code: meta.code, name: meta.name, description: meta.description },
    { onConflict: "code" }
  )
  .select()
  .single();
if (e1) await fail("standards", e1);

// 2. Version du référentiel (échoue si déjà publiée : incrémentez referential_version)
const { data: existing } = await supabase
  .from("standard_versions")
  .select("id")
  .eq("standard_id", standard.id)
  .eq("edition", meta.edition)
  .eq("referential_version", meta.referential_version)
  .maybeSingle();

if (existing) {
  console.error(
    `La version ${meta.referential_version} existe déjà. Les versions publiées sont immuables ` +
    `(les projets clients y sont épinglés) — incrémentez referential_version dans meta.json.`
  );
  process.exit(1);
}

const { data: version, error: e2 } = await supabase
  .from("standard_versions")
  .insert({
    standard_id: standard.id,
    edition: meta.edition,
    referential_version: meta.referential_version,
    is_current: true,
  })
  .select()
  .single();
if (e2) await fail("standard_versions", e2);

// Désépingle les anciennes versions courantes
await supabase
  .from("standard_versions")
  .update({ is_current: false })
  .eq("standard_id", standard.id)
  .neq("id", version.id);

// 3. Clauses (deux passes : insertion, puis rattachement parent par préfixe de numéro)
const clauseIdByNumber = {};
for (const [i, c] of clauses.entries()) {
  const { data, error } = await supabase
    .from("clauses")
    .insert({
      standard_version_id: version.id,
      number: c.number,
      title: c.title,
      requirement_text: c.requirement,
      sort_order: i,
    })
    .select()
    .single();
  if (error) await fail(`clause ${c.number}`, error);
  clauseIdByNumber[c.number] = data.id;
}

for (const c of clauses) {
  const parentNumber = c.number.includes(".")
    ? c.number.split(".").slice(0, -1).join(".")
    : null;
  if (parentNumber && clauseIdByNumber[parentNumber]) {
    const { error } = await supabase
      .from("clauses")
      .update({ parent_clause_id: clauseIdByNumber[parentNumber] })
      .eq("id", clauseIdByNumber[c.number]);
    if (error) await fail(`parent de ${c.number}`, error);
  }
}
console.log(`  ${clauses.length} clauses insérées`);

// 4. Documents requis + rattachements aux clauses
let links = 0;
for (const [i, d] of documents.entries()) {
  const { data, error } = await supabase
    .from("required_documents")
    .insert({
      standard_version_id: version.id,
      key: d.key,
      title: d.title,
      description: d.description,
      evidence_type: d.evidence_type,
      is_mandatory: d.is_mandatory,
      generation_case: d.generation_case,
      field_schema: d.field_schema ?? null,
      source_hints: d.source_hints ?? null,
      generation_template: d.generation_template ?? null,
      validation_rules: d.validation_rules ?? null,
      sort_order: i,
    })
    .select()
    .single();
  if (error) await fail(`document ${d.key}`, error);

  for (const number of d.clauses ?? []) {
    const clauseId = clauseIdByNumber[number];
    if (!clauseId) {
      console.error(`  Avertissement : clause ${number} introuvable (document ${d.key})`);
      continue;
    }
    const { error: eLink } = await supabase
      .from("clause_documents")
      .insert({ clause_id: clauseId, required_document_id: data.id });
    if (eLink) await fail(`lien ${d.key} ↔ ${number}`, eLink);
    links++;
  }
}
console.log(`  ${documents.length} documents requis insérés (${links} rattachements de clauses)`);
console.log(`Terminé : ${meta.code} ${meta.edition} — référentiel v${meta.referential_version} (version courante).`);
