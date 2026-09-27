# eContract demo

A contract builder demo: contractors pick a contract, fill its fixed main section, choose optional sub-sections, and save. Each saved contract keeps a JSON copy of its wording and values, and every input is also written to a reporting row.

Two sample contracts are included:

- **Villa Construction Contract** (عقد إنشاء فيلا) – a small English example.
- **Turnkey Contract** (عقد تسليم المفتاح) – the special-conditions and technical-specifications annexes in Arabic, with payment, bill-of-quantities, phases and warranty tables and 8 optional work sections.

## Running it

Needs PHP 8.1+ (for example XAMPP). Put the folder under the web root and open `http://localhost/econtract_demo/`.

There is no database: tables are JSON files in `data/`, read and written through `api.php`. On first request each table is copied from `data/seed/`. "Reset demo data" restores the seed.

## Static hosting (GitHub Pages)

The site also runs without PHP. `api-client.js` checks whether `api.php` answers with JSON; if not, it loads `data/schema.json` and `data/seed/*.json` and applies the same checks as `api.php` in the browser. Changes are then saved in each visitor's browser (localStorage) only, so every visitor starts from the seed data and "Reset demo data" restores it.

To publish on GitHub Pages: repository **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`. The site is served at `https://<user>.github.io/<repo>/`.

## Pages

| Page | What it does |
| --- | --- |
| `index.html` | Contract list, builder with live preview, saved contracts, database tables and the Laravel migration for `contract_details` |
| `contract.html?id=…` | A saved contract as a printable A4 document |
| `data.html` | Add and edit rows in every table, with a record-level relations diagram |
| `erd.html` | Schema diagram |
| `showcase.html` | Client-facing overview of the villa example |

## Data model

| Table | Holds |
| --- | --- |
| `contracts` | Contracts shown in the index (`title_ar`, `title_en`) |
| `contract_sections` | Reusable templates: one `main` and any number of `sub` sections per contract (`template_structure`, `template`, `rules` as JSON) |
| `user_contracts` | A contractor's saved instance: `main_contract` and `sub_contract[]` snapshots with entered values |
| `contract_details` | One reporting row per saved contract; every template input key is a column, NULL when its section isn't selected |
| `users` | Contractors |

`data/schema.json` defines columns, foreign keys and the ids referenced inside JSON (`sub_contract[].source_section_id`); `api.php` enforces them.

Template paragraphs, input types (`text`, `decimal`, `choice`, `multi`, `table`, `textarea`) and conditional clauses are documented at the top of `contract-render.js`, which renders both the builder preview and the document page.
