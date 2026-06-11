// Insertion d'un référentiel complet en base (norme + version + clauses + documents).
// Utilisé par api/standards/generate.js ; même logique que scripts/seed-referentiel.mjs.
import { supabaseAdmin } from "./supabaseAdmin.js";

export async function insertReferentiel({ meta, clauses, documents, origin }) {
  const { data: standard, error: e1 } = await supabaseAdmin
    .from("standards")
    .upsert(
      { code: meta.code, name: meta.name, description: meta.description },
      { onConflict: "code" }
    )
    .select()
    .single();
  if (e1) throw new Error(`standards : ${e1.message}`);

  const { data: version, error: e2 } = await supabaseAdmin
    .from("standard_versions")
    .insert({
      standard_id: standard.id,
      edition: meta.edition,
      referential_version: meta.referential_version,
      is_current: true,
      origin: origin || "manual",
    })
    .select()
    .single();
  if (e2) throw new Error(`standard_versions : ${e2.message}`);

  await supabaseAdmin
    .from("standard_versions")
    .update({ is_current: false })
    .eq("standard_id", standard.id)
    .neq("id", version.id);

  // Clauses (insertion puis rattachement parent par préfixe de numéro)
  const clauseIdByNumber = {};
  for (const [i, c] of clauses.entries()) {
    const { data, error } = await supabaseAdmin
      .from("clauses")
      .insert({
        standard_version_id: version.id,
        number: c.number,
        title: c.title,
        requirement_text: c.requirement || null,
        sort_order: i,
      })
      .select()
      .single();
    if (error) throw new Error(`clause ${c.number} : ${error.message}`);
    clauseIdByNumber[c.number] = data.id;
  }
  for (const c of clauses) {
    const parentNumber = c.number.includes(".")
      ? c.number.split(".").slice(0, -1).join(".")
      : null;
    if (parentNumber && clauseIdByNumber[parentNumber]) {
      await supabaseAdmin
        .from("clauses")
        .update({ parent_clause_id: clauseIdByNumber[parentNumber] })
        .eq("id", clauseIdByNumber[c.number]);
    }
  }

  // Documents requis + rattachements
  for (const [i, d] of documents.entries()) {
    const { data, error } = await supabaseAdmin
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
    if (error) throw new Error(`document ${d.key} : ${error.message}`);

    for (const number of d.clauses ?? []) {
      const clauseId = clauseIdByNumber[number];
      if (!clauseId) continue;
      await supabaseAdmin
        .from("clause_documents")
        .insert({ clause_id: clauseId, required_document_id: data.id });
    }
  }

  return { standard, version };
}
