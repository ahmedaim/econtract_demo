/**
 * Data access for every page.
 *
 * With PHP available (XAMPP) requests go to api.php and data is shared in data/*.json.
 * On a static host (GitHub Pages) api.php can't run, so the same API is served in the browser:
 * tables start from data/seed/*.json and changes are kept in this browser's localStorage.
 * The static mode applies the same checks as api.php (required fields, foreign keys,
 * ids inside JSON, delete protection, reporting columns).
 *
 *   await EContractAPI.get()        -> { schema, reporting_columns, tables }
 *   await EContractAPI.post(body)   -> same actions as api.php: upsert | delete | reset
 *   EContractAPI.mode               -> "server" | "static" (after the first call)
 */
(function () {
  "use strict";

  const STORE_KEY = "econtract_demo_tables_v1";
  let mode = null;
  let schema = null;
  let tables = null;

  const clone = o => JSON.parse(JSON.stringify(o));
  const fail = message => { throw new Error(message); };

  async function detect() {
    if (mode) return mode;
    try {
      const res = await fetch("api.php", { cache: "no-store" });
      if (res.ok && (res.headers.get("content-type") || "").includes("application/json")) {
        mode = "server";
        return mode;
      }
    } catch { /* no PHP: fall through */ }
    mode = "static";
    return mode;
  }

  /* ---------------- static mode ---------------- */

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) fail(`Could not load ${url} (${res.status}).`);
    return res.json();
  }

  async function loadSeed() {
    const out = {};
    for (const t of Object.keys(schema)) out[t] = await fetchJson(`data/seed/${t}.json`);
    return out;
  }

  async function ensureStatic() {
    if (!schema) schema = await fetchJson("data/schema.json");
    if (tables) return;
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) tables = JSON.parse(saved);
    } catch { /* storage blocked: use seed */ }
    if (!tables) tables = await loadSeed();
    for (const t of Object.keys(schema)) tables[t] ||= [];
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(tables)); }
    catch { /* storage full or blocked: changes last until the page is reloaded */ }
  }

  const findRow = (table, id) => (tables[table] || []).find(r => Number(r.id) === Number(id)) || null;

  // Reporting columns of contract_details = every input key declared by any section template.
  function reportingColumns() {
    const cols = {};
    for (const s of tables.contract_sections || []) {
      for (const i of s.template_structure?.inputs || []) cols[i.key] = i.type || "text";
    }
    return cols;
  }

  function jsonRefIds(value, key) {
    if (!value || typeof value !== "object") return [];
    const items = Array.isArray(value) ? value : [value];
    return items.filter(it => it && typeof it === "object" && it[key] != null && it[key] !== "").map(it => it[key]);
  }

  function validateRow(table, input) {
    const def = schema[table];
    const row = {};

    for (const col of def.columns) {
      const name = col.name;
      let value = input[name];
      if (value === "" || value === undefined) value = null;

      if (col.type === "pk") {
        if (value !== null) {
          if (isNaN(Number(value))) fail(`${name} must be a number.`);
          row[name] = Number(value);
        }
        continue;
      }
      if (value === null) {
        if (col.required) fail(`${name} is required.`);
        row[name] = null;
        continue;
      }
      switch (col.type) {
        case "fk":
          if (isNaN(Number(value))) fail(`${name} must be a number.`);
          value = Number(value);
          if (!findRow(col.ref, value)) fail(`${name} = ${value} does not exist in ${col.ref}.`);
          break;
        case "enum":
          if (!col.values.includes(value)) fail(`${name} must be one of: ${col.values.join(", ")}.`);
          break;
        case "json":
          if (typeof value === "string") {
            try { value = JSON.parse(value); } catch { fail(`${name} is not valid JSON.`); }
          }
          if (!value || typeof value !== "object") fail(`${name} must be a JSON object or array.`);
          break;
        default:
          value = String(value).trim();
      }
      row[name] = value;
    }

    for (const ref of def.json_refs || []) {
      for (const id of jsonRefIds(row[ref.column], ref.key)) {
        if (!findRow(ref.ref, id)) fail(`${ref.column}.${ref.key} = ${id} does not exist in ${ref.ref}.`);
      }
    }

    if (def.reporting_columns) {
      for (const [key, type] of Object.entries(reportingColumns())) {
        let value = input[key];
        if (value === "" || value == null) { row[key] = null; continue; }
        if (type === "table" || type === "multi") {
          if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = null; } }
          if (!Array.isArray(value)) fail(`${key} must be a JSON array.`);
          row[key] = value;
        } else if (type === "decimal") {
          if (isNaN(Number(value))) fail(`${key} must be a number.`);
          row[key] = Number(value).toFixed(2);
        } else {
          row[key] = String(value).trim();
        }
      }
    }
    return row;
  }

  function referencesTo(table, id) {
    const refs = [];
    for (const [other, def] of Object.entries(schema)) {
      const fkCols = def.columns.filter(c => c.type === "fk" && c.ref === table);
      const jsonRefs = (def.json_refs || []).filter(r => r.ref === table);
      if (!fkCols.length && !jsonRefs.length) continue;
      for (const row of tables[other] || []) {
        for (const c of fkCols) if (Number(row[c.name]) === id) refs.push(`${other} #${row.id} (${c.name})`);
        for (const r of jsonRefs) if (jsonRefIds(row[r.column], r.key).map(Number).includes(id)) refs.push(`${other} #${row.id} (${r.column})`);
      }
    }
    return [...new Set(refs)];
  }

  async function staticPost(body) {
    await ensureStatic();
    const { action, table } = body;

    if (action === "reset") {
      tables = await loadSeed();
      try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
      return { ok: true };
    }
    if (!schema[table]) fail("Unknown table.");

    if (action === "upsert") {
      const row = validateRow(table, body.row || {});
      const rows = tables[table];
      if (row.id == null) row.id = rows.length ? Math.max(...rows.map(r => Number(r.id))) + 1 : schema[table].id_start;
      const ordered = { id: row.id, ...row };
      const i = rows.findIndex(r => Number(r.id) === ordered.id);
      if (i >= 0) rows[i] = ordered; else rows.push(ordered);
      rows.sort((a, b) => a.id - b.id);
      persist();
      return { row: clone(ordered), created: i < 0 };
    }

    if (action === "delete") {
      const id = Number(body.id);
      const refs = referencesTo(table, id);
      if (refs.length) fail(`${table} #${id} is still referenced by: ${refs.join(", ")}.`);
      tables[table] = tables[table].filter(r => Number(r.id) !== id);
      persist();
      return { ok: true };
    }
    fail("Unknown action.");
  }

  /* ---------------- public API ---------------- */

  async function get() {
    if (await detect() === "server") {
      const res = await fetch("api.php", { cache: "no-store" });
      if (!res.ok) fail(`api.php returned ${res.status}`);
      return res.json();
    }
    await ensureStatic();
    return clone({ schema, reporting_columns: reportingColumns(), tables });
  }

  async function post(body) {
    if (await detect() === "server") {
      const res = await fetch("api.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || data.error) fail(data.error || `HTTP ${res.status}`);
      return data;
    }
    return staticPost(body);
  }

  window.EContractAPI = {
    get,
    post,
    get mode() { return mode; }
  };
})();
