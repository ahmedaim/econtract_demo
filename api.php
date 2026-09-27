<?php
/**
 * Tiny JSON-file "database" for the eContract demo.
 *
 * Each table is stored in data/<table>.json; data/schema.json describes the
 * columns, foreign keys and references stored inside JSON columns.
 *
 *   GET  api.php                                   -> { schema, tables }
 *   POST api.php {"action":"upsert","table":T,"row":{...}}   insert, or replace by id
 *   POST api.php {"action":"delete","table":T,"id":N}        refused while referenced
 *   POST api.php {"action":"reset"}                          restore data/seed/*.json
 */

header('Content-Type: application/json; charset=utf-8');

const DATA_DIR = __DIR__ . '/data';
const SEED_DIR = DATA_DIR . '/seed';

$schema = json_decode(file_get_contents(DATA_DIR . '/schema.json'), true);

function respond($data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $code = 422, array $extra = []): void
{
    respond(['error' => $message] + $extra, $code);
}

function table_path(string $table): string
{
    return DATA_DIR . "/$table.json";
}

function read_table(string $table): array
{
    $path = table_path($table);
    if (!is_file($path) && is_file(SEED_DIR . "/$table.json")) {
        copy(SEED_DIR . "/$table.json", $path);
    }
    if (!is_file($path)) {
        return [];
    }
    $rows = json_decode(file_get_contents($path), true);
    return is_array($rows) ? $rows : [];
}

function write_table(string $table, array $rows): void
{
    usort($rows, fn($a, $b) => $a['id'] <=> $b['id']);
    $json = json_encode(array_values($rows), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    file_put_contents(table_path($table), $json . "\n", LOCK_EX);
}

function find_row(string $table, $id): ?array
{
    foreach (read_table($table) as $row) {
        if ((int) $row['id'] === (int) $id) {
            return $row;
        }
    }
    return null;
}

/** Reporting columns of contract_details = every input key declared by any section template. */
function reporting_columns(): array
{
    $cols = [];
    foreach (read_table('contract_sections') as $section) {
        foreach ($section['template_structure']['inputs'] ?? [] as $input) {
            $cols[$input['key']] = $input['type'] ?? 'text';
        }
    }
    return $cols;
}

/** Collect source ids referenced inside a JSON column (object or list of objects). */
function json_ref_ids($value, string $key): array
{
    if (!is_array($value)) {
        return [];
    }
    $items = array_is_list($value) ? $value : [$value];
    $ids = [];
    foreach ($items as $item) {
        if (is_array($item) && isset($item[$key]) && $item[$key] !== '') {
            $ids[] = $item[$key];
        }
    }
    return $ids;
}

function validate_row(string $table, array $input, array $schema): array
{
    $def = $schema[$table];
    $row = [];

    foreach ($def['columns'] as $col) {
        $name = $col['name'];
        $value = $input[$name] ?? null;
        if ($value === '') {
            $value = null;
        }

        if ($col['type'] === 'pk') {
            if ($value !== null) {
                if (!is_numeric($value)) {
                    fail("$name must be a number.");
                }
                $row[$name] = (int) $value;
            }
            continue;
        }

        if ($value === null) {
            if (!empty($col['required'])) {
                fail("$name is required.");
            }
            $row[$name] = null;
            continue;
        }

        switch ($col['type']) {
            case 'fk':
                if (!is_numeric($value)) {
                    fail("$name must be a number.");
                }
                $value = (int) $value;
                if (!find_row($col['ref'], $value)) {
                    fail("$name = $value does not exist in {$col['ref']}.");
                }
                break;
            case 'enum':
                if (!in_array($value, $col['values'], true)) {
                    fail("$name must be one of: " . implode(', ', $col['values']) . '.');
                }
                break;
            case 'json':
                if (is_string($value)) {
                    $value = json_decode($value, true);
                    if (json_last_error() !== JSON_ERROR_NONE) {
                        fail("$name is not valid JSON.");
                    }
                }
                if (!is_array($value)) {
                    fail("$name must be a JSON object or array.");
                }
                break;
            default:
                $value = trim((string) $value);
        }
        $row[$name] = $value;
    }

    foreach ($def['json_refs'] ?? [] as $ref) {
        foreach (json_ref_ids($row[$ref['column']] ?? null, $ref['key']) as $id) {
            if (!find_row($ref['ref'], $id)) {
                fail("{$ref['column']}.{$ref['key']} = $id does not exist in {$ref['ref']}.");
            }
        }
    }

    if (!empty($def['reporting_columns'])) {
        foreach (reporting_columns() as $key => $type) {
            $value = $input[$key] ?? null;
            if ($value === '' || $value === null) {
                $row[$key] = null;
            } elseif ($type === 'table' || $type === 'multi') {
                // Stored as a JSON column.
                if (is_string($value)) {
                    $value = json_decode($value, true);
                }
                if (!is_array($value)) {
                    fail("$key must be a JSON array.");
                }
                $row[$key] = $value;
            } elseif ($type === 'decimal') {
                if (!is_numeric($value)) {
                    fail("$key must be a number.");
                }
                $row[$key] = number_format((float) $value, 2, '.', '');
            } else {
                $row[$key] = trim((string) $value);
            }
        }
    }

    return $row;
}

/** Rows in other tables that point at $table.$id (FK columns and references inside JSON). */
function references_to(string $table, int $id, array $schema): array
{
    $refs = [];
    foreach ($schema as $other => $def) {
        $fkCols = array_filter($def['columns'], fn($c) => $c['type'] === 'fk' && $c['ref'] === $table);
        $jsonRefs = array_filter($def['json_refs'] ?? [], fn($r) => $r['ref'] === $table);
        if (!$fkCols && !$jsonRefs) {
            continue;
        }
        foreach (read_table($other) as $row) {
            foreach ($fkCols as $c) {
                if ((int) ($row[$c['name']] ?? 0) === $id) {
                    $refs[] = "$other #{$row['id']} ({$c['name']})";
                }
            }
            foreach ($jsonRefs as $r) {
                if (in_array($id, array_map('intval', json_ref_ids($row[$r['column']] ?? null, $r['key'])), true)) {
                    $refs[] = "$other #{$row['id']} ({$r['column']})";
                }
            }
        }
    }
    return array_values(array_unique($refs));
}

/* ---------------- routing ---------------- */

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $tables = [];
    foreach (array_keys($schema) as $table) {
        $tables[$table] = read_table($table);
    }
    respond(['schema' => $schema, 'reporting_columns' => reporting_columns(), 'tables' => $tables]);
}

$body = json_decode(file_get_contents('php://input'), true) ?? [];
$action = $body['action'] ?? '';
$table = $body['table'] ?? '';

// Serialise writes so two requests can't interleave read-modify-write on the files.
$lock = fopen(DATA_DIR . '/.lock', 'c');
flock($lock, LOCK_EX);

if ($action === 'reset') {
    foreach (array_keys($schema) as $t) {
        copy(SEED_DIR . "/$t.json", table_path($t));
    }
    respond(['ok' => true]);
}

if (!isset($schema[$table])) {
    fail('Unknown table.', 400);
}

if ($action === 'upsert') {
    $row = validate_row($table, $body['row'] ?? [], $schema);
    $rows = read_table($table);
    if (!isset($row['id'])) {
        $ids = array_column($rows, 'id');
        $row['id'] = $ids ? max($ids) + 1 : $schema[$table]['id_start'];
    }
    $row = ['id' => $row['id']] + $row;

    $replaced = false;
    foreach ($rows as $i => $existing) {
        if ((int) $existing['id'] === $row['id']) {
            $rows[$i] = $row;
            $replaced = true;
        }
    }
    if (!$replaced) {
        $rows[] = $row;
    }
    write_table($table, $rows);
    respond(['row' => $row, 'created' => !$replaced]);
}

if ($action === 'delete') {
    $id = (int) ($body['id'] ?? 0);
    $refs = references_to($table, $id, $schema);
    if ($refs) {
        fail("$table #$id is still referenced by: " . implode(', ', $refs) . '.', 409, ['references' => $refs]);
    }
    write_table($table, array_filter(read_table($table), fn($r) => (int) $r['id'] !== $id));
    respond(['ok' => true]);
}

fail('Unknown action.', 400);
