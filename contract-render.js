/**
 * Shared contract logic for the builder preview (index.html), the document page (contract.html)
 * and the data generator. Works on "snapshot" parts: the JSON stored in user_contracts.main_contract
 * and user_contracts.sub_contract[].
 *
 * Paragraph types (template.paragraphs[].type):
 *   annex | article | sub   headings (numbering of clauses restarts under each)
 *   clause                  numbered paragraph
 *   text | note             plain / muted paragraph
 *   choice                  shows a choice input as ticked boxes          { input }
 *   table                   renders a table input                         { input }
 *   input                   renders a long-text input                     { input }
 *   auto                    generated from the selected sub-sections      { source: scope | specs | warranties }
 * Any paragraph may carry `when: { input, equals }` to show it only for that choice.
 */
(function (root) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const AR_LETTERS = ["أ", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز", "س"];
  const AR_ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  const TEXT = {
    rtl: {
      total: "المجموع", none: "لا يوجد", empty: "-", blank: "...............", section: "القسم", sectionTitle: "عنوان القسم",
      items: "البنود", no: "م", scope: "نطاق الضمان", duration: "مدة الضمان", notes: "ملاحظات", extra: "نص إضافي",
      noSections: "لم يتم اختيار أي قسم من أقسام الأعمال.", added: "إضافي"
    },
    ltr: {
      total: "Total", none: "None", empty: "-", blank: "...............", section: "Section", sectionTitle: "Section title",
      items: "Items", no: "No.", scope: "Warranty scope", duration: "Duration", notes: "Notes", extra: "Additional text",
      noSections: "No work sections selected.", added: "Additional"
    }
  };

  /* ---------------- values ---------------- */

  // Evaluate a template formula such as "unit_price * quantity" against a table row and the form values.
  function evalFormula(formula, row, values) {
    const expr = String(formula).replace(/[a-z_][a-z0-9_]*/gi, name => {
      const v = row?.[name] ?? values?.[name];
      const n = Number(v);
      return v === "" || v == null || isNaN(n) ? "NaN" : String(n);
    });
    if (!/^[\d.\s+\-*/()NaN]+$/.test(expr)) return NaN;
    try { return Function(`"use strict"; return (${expr});`)(); } catch { return NaN; }
  }

  const toFixed2 = v => (v === "" || v == null || isNaN(Number(v)) ? "" : Number(v).toFixed(2));

  // Normalize an entered value to what is stored (decimals as "0.00", tables with computed columns filled).
  function normalizeValue(input, v, values) {
    switch (input.type) {
      case "decimal": return v === "" || v == null ? "" : isNaN(Number(v)) ? String(v).trim() : Number(v).toFixed(2);
      case "multi": return Array.isArray(v) ? [...v] : [];
      case "table":
        return (Array.isArray(v) ? v : []).map(row => {
          const out = {};
          for (const c of input.columns) {
            if (c.type === "computed") out[c.key] = toFixed2(evalFormula(c.formula, row, values));
            else if (c.type === "decimal") out[c.key] = toFixed2(row?.[c.key]);
            else out[c.key] = String(row?.[c.key] ?? "").trim();
          }
          return out;
        });
      default: return v == null ? "" : String(v).trim();
    }
  }

  // Starting value of an input when a contractor opens a section.
  function defaultValue(input, structure) {
    if (input.default !== undefined) return JSON.parse(JSON.stringify(input.default));
    if (input.default_from) return (structure[input.default_from] || []).map(m => ({ [input.columns[0].key]: m }));
    return input.type === "table" || input.type === "multi" ? [] : "";
  }

  // Copy a template section into the JSON stored on user_contracts, together with the entered values.
  function snapshot(section, values, order) {
    const { inputs, ...structure } = JSON.parse(JSON.stringify(section.template_structure));
    const snap = {
      source_section_id: section.id,
      section_key: structure.section_key,
      version: structure.version,
      title: section.template.title,
      fixed: structure.fixed
    };
    if (order != null) snap.order = order;
    Object.assign(snap, structure, {
      paragraphs: JSON.parse(JSON.stringify(section.template.paragraphs)),
      inputs: inputs.map(i => ({ ...i, value: normalizeValue(i, values[i.key] ?? defaultValue(i, structure), values) })),
      rules: JSON.parse(JSON.stringify(section.rules))
    });
    return snap;
  }

  function valuesOf(parts) {
    const v = {};
    for (const p of parts) for (const i of p.inputs || []) v[i.key] = i.value;
    return v;
  }

  // Items ticked inside the selected sub-sections, e.g. { value: "site_works.fencing", label, item, part }.
  function selectedItems(parts) {
    const out = [];
    for (const part of parts) {
      const multi = (part.inputs || []).find(i => i.type === "multi");
      if (!multi || !part[multi.source]) continue;
      const chosen = new Set(multi.value || []);
      for (const item of part[multi.source]) {
        if (chosen.has(item.key)) out.push({ value: `${part.section_key}.${item.key}`, label: item.title, item, part });
      }
    }
    return out;
  }

  const isTyped = part => (part?.paragraphs || []).some(p => p.type);
  const isRtl = parts => parts.some(p => p?.dir === "rtl");

  /* ---------------- rendering ---------------- */

  function renderBody(parts, opts = {}) {
    const main = parts[0];
    const subs = parts.slice(1).sort((a, b) => (a.section_no ?? 99) - (b.section_no ?? 99) || (a.order ?? 0) - (b.order ?? 0));
    const rtl = isRtl(parts);
    const ctx = {
      main, subs, rtl, highlight: !!opts.highlight,
      t: TEXT[rtl ? "rtl" : "ltr"],
      values: valuesOf(parts),
      inputs: Object.fromEntries(parts.flatMap(p => (p.inputs || []).map(i => [i.key, i]))),
      items: new Map(selectedItems(parts).map(s => [s.value, s]))
    };
    let html = renderParagraphs(main, ctx);
    for (const s of subs) if ((s.paragraphs || []).length) html += `<h3 class="cr-article">${esc(s.title)}</h3>${renderParagraphs(s, ctx)}`;
    return `<div class="cr-doc" dir="${rtl ? "rtl" : "ltr"}">${html}</div>`;
  }

  const num = (n, ctx) => (ctx.rtl ? Number(n).toLocaleString("ar-EG", { useGrouping: false }) : String(n));
  const letter = (i, ctx) => (ctx.rtl ? AR_LETTERS[i] ?? i + 1 : String.fromCharCode(97 + i));
  const ordinal = (n, ctx) => (ctx.rtl ? AR_ORDINALS[n - 1] ?? n : String(n));
  const box = on => `<span class="cr-box ${on ? "on" : ""}" aria-label="${on ? "selected" : "not selected"}"></span>`;
  const visible = (p, ctx) => !p.when || String(ctx.values[p.when.input] ?? "") === String(p.when.equals);

  function formatNumber(v, col) {
    if (v === "" || v == null || isNaN(Number(v))) return null;
    const n = Number(v);
    const s = col?.money ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
    return s + (col?.suffix || "");
  }

  function fill(text, ctx) {
    return esc(text).replace(/\{\{(\w+)\}\}/g, (_, k) => {
      const input = ctx.inputs[k];
      let v = ctx.values[k];
      if (input?.type === "decimal") v = formatNumber(v, { money: true });
      if (input?.type === "choice") v = input.options.find(o => o.value === v)?.label ?? v;
      if (v == null || v === "") return `<span class="cr-missing">[${esc(input?.label || k)}]</span>`;
      return ctx.highlight ? `<span class="cr-val">${esc(v)}</span>` : esc(v);
    });
  }

  function renderParagraphs(part, ctx) {
    const paras = part.paragraphs || [];
    const byId = new Map(paras.map(p => [p.id, p]));
    const order = part.paragraph_order?.length ? part.paragraph_order : paras.map(p => p.id);
    let n = 0, out = "";
    for (const id of order) {
      const p = byId.get(id);
      if (!p || !visible(p, ctx)) continue;
      switch (p.type) {
        case "annex": n = 0; out += `<h2 class="cr-annex">${fill(p.text, ctx)}</h2>`; break;
        case "article": n = 0; out += `<h3 class="cr-article">${fill(p.text, ctx)}</h3>`; break;
        case "sub": n = 0; out += `<h4 class="cr-sub">${fill(p.text, ctx)}</h4>`; break;
        case "note": out += `<p class="cr-note">${fill(p.text, ctx)}</p>`; break;
        case "clause": n++; out += clause(num(n, ctx), fill(p.text, ctx)); break;
        case "choice": out += renderChoice(p, ctx); break;
        case "table": out += renderTable(ctx.inputs[p.input], ctx.values[p.input], ctx); break;
        case "input": out += renderLongText(ctx.values[p.input], ctx); break;
        case "auto": out += (AUTO[p.source] || (() => ""))(ctx); break;
        default: out += `<p class="cr-text">${fill(p.text, ctx)}</p>`;
      }
    }
    return out;
  }

  const clause = (no, html) => `<div class="cr-clause"><span class="cr-no">${no}-</span><p>${html}</p></div>`;

  function renderChoice(p, ctx) {
    const input = ctx.inputs[p.input];
    if (!input) return "";
    const v = ctx.values[p.input];
    return `<p class="cr-choice"><b>${fill(p.text, ctx)}</b>${input.options.map(o =>
      `<span class="cr-opt">${esc(o.label)} ${box(v === o.value)}</span>`).join("")}</p>`;
  }

  function renderLongText(v, ctx) {
    const lines = String(v ?? "").split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return `<p class="cr-note cr-start">${ctx.t.none}</p>`;
    return lines.map((l, i) => clause(num(i + 1, ctx), esc(l))).join("");
  }

  function cellText(col, row, ctx, emptyText) {
    const v = row?.[col.key];
    if (v === "" || v == null) return emptyText;
    if (col.type === "decimal" || col.type === "computed") return esc(formatNumber(v, col) ?? v);
    if (col.source === "selected_items") return esc(ctx.items.get(v)?.label ?? v);
    return esc(v);
  }

  function renderTable(input, rows, ctx, opts = {}) {
    if (!input) return "";
    rows = rows || [];
    const cols = input.columns;
    const emptyText = opts.emptyText ?? ctx.t.empty;
    const numbered = !!input.numbered;
    const isNum = c => c.type === "decimal" || c.type === "computed";
    const head = (numbered ? `<th class="cr-n">${esc(input.numbered)}</th>` : "") + cols.map(c => `<th>${esc(c.label)}</th>`).join("");
    const body = rows.length
      ? rows.map((r, i) => `<tr>${numbered ? `<td class="cr-n">${num(i + 1, ctx)}</td>` : ""}${cols.map(c =>
          `<td class="${isNum(c) ? "cr-num" : ""}">${cellText(c, r, ctx, emptyText)}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${cols.length + (numbered ? 1 : 0)}" class="cr-emptyrow">${ctx.t.none}</td></tr>`;
    let foot = "";
    if (cols.some(c => c.total) && rows.length) {
      const cells = cols.map((c, i) => {
        if (c.total) {
          const vals = rows.map(r => r[c.key]).filter(v => v !== "" && v != null && !isNaN(Number(v)));
          const sum = vals.length ? vals.reduce((a, v) => a + Number(v), 0) : null;
          return `<td class="cr-num">${sum == null ? ctx.t.empty : esc(formatNumber(sum, c))}</td>`;
        }
        return i === 0 && !numbered ? `<td>${ctx.t.total}</td>` : "<td></td>";
      }).join("");
      foot = `<tfoot><tr class="cr-total">${numbered ? `<td>${ctx.t.total}</td>` : ""}${cells}</tr></tfoot>`;
    }
    const caption = opts.caption ? `<caption>${esc(opts.caption)}</caption>` : "";
    return `<div class="cr-wrap"><table class="cr-table ${opts.className || ""}">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  const chosenSet = part => {
    const multi = (part.inputs || []).find(i => i.type === "multi");
    return new Set(multi?.value || []);
  };

  const AUTO = {
    // Article 2 scope table: every selected section with its items ticked or not.
    scope(ctx) {
      if (!ctx.subs.length) return `<p class="cr-note cr-start">${ctx.t.noSections}</p>`;
      const rows = ctx.subs.map(s => {
        const chosen = chosenSet(s);
        return `<tr><td class="cr-n">${num(s.section_no ?? "", ctx)}</td><td><b>${esc(s.title)}</b></td><td><ul class="cr-items">${(s.items || []).map((it, i) =>
          `<li class="${chosen.has(it.key) ? "" : "cr-off"}">${box(chosen.has(it.key))}<span>${letter(i, ctx)}. ${esc(it.title)}</span></li>`).join("")}</ul></td></tr>`;
      }).join("");
      return `<div class="cr-wrap"><table class="cr-table"><thead><tr><th class="cr-n">${ctx.t.section}</th><th>${ctx.t.sectionTitle}</th><th>${ctx.t.items}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    },

    // Technical specification text of the selected items, followed by each section's materials table.
    specs(ctx) {
      if (!ctx.subs.length) return `<p class="cr-note cr-start">${ctx.t.noSections}</p>`;
      return ctx.subs.map(s => {
        const chosen = chosenSet(s);
        const blocks = (s.items || []).filter(it => chosen.has(it.key)).flatMap(it => (it.specs || []).map(sp => ({ ...sp, title: sp.title || it.title })));
        const extra = (s.inputs || []).find(i => i.type === "textarea");
        const materials = (s.inputs || []).find(i => i.type === "table");
        const extraLines = String(extra?.value ?? "").split(/\n+/).map(x => x.trim()).filter(Boolean);
        return `<section class="cr-spec-section">
          <h4 class="cr-section">${ctx.t.section} ${ordinal(s.section_no, ctx)}: ${esc(s.title)}</h4>
          ${blocks.map((b, i) => `<div class="cr-spec">
            <h5>${letter(i, ctx)}. ${esc(b.title)}:</h5>
            ${b.intro ? `<p class="cr-intro">${esc(b.intro)}</p>` : ""}
            ${(b.clauses || []).map((c, j) => clause(num(j + 1, ctx), esc(c))).join("")}
          </div>`).join("")}
          ${extraLines.length ? `<div class="cr-spec"><h5>${ctx.t.extra}:</h5>${extraLines.map((l, j) => clause(num(j + 1, ctx), esc(l))).join("")}</div>` : ""}
          ${materials ? renderTable(materials, materials.value, ctx, { emptyText: ctx.t.blank, caption: materials.label, className: "cr-mat" }) : ""}
        </section>`;
      }).join("");
    },

    // Warranty table: warranties of the selected sections/items plus any added by the parties.
    warranties(ctx) {
      const rows = [];
      for (const s of ctx.subs) {
        const chosen = chosenSet(s);
        for (const w of s.warranties || []) {
          if (!w.item || chosen.has(w.item)) rows.push([ordinal(s.section_no, ctx), w.scope, w.duration, ""]);
        }
      }
      for (const w of ctx.values.extra_warranties || []) {
        if (w.scope) rows.push([ctx.t.added, w.scope, w.duration, w.notes]);
      }
      const body = rows.length
        ? rows.map((r, i) => `<tr><td class="cr-n">${num(i + 1, ctx)}</td>${r.map(c => `<td>${esc(c || "")}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="5" class="cr-emptyrow">${ctx.t.none}</td></tr>`;
      return `<div class="cr-wrap"><table class="cr-table"><thead><tr><th class="cr-n">${ctx.t.no}</th><th>${ctx.t.section}</th><th>${ctx.t.scope}</th><th>${ctx.t.duration}</th><th>${ctx.t.notes}</th></tr></thead><tbody>${body}</tbody></table></div>`;
    }
  };

  const CR = { esc, evalFormula, normalizeValue, defaultValue, snapshot, valuesOf, selectedItems, isTyped, isRtl, renderBody, formatNumber, TEXT };
  if (typeof module !== "undefined" && module.exports) module.exports = CR;
  else root.ContractRender = CR;
})(typeof window !== "undefined" ? window : globalThis);
