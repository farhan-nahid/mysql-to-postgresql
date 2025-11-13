# MySQL to PostgreSQL Migration Tool

A robust TypeScript-based migration tool for migrating databases from MySQL to PostgreSQL with intelligent type mapping, error handling, and recovery features.

## Features

- **Automatic Type Mapping**: Converts MySQL data types to PostgreSQL equivalents (e.g., `tinyint` → `smallint`, `json` → `jsonb`)
- **Reserved Keyword Handling**: Automatically quotes column names to handle PostgreSQL reserved keywords (e.g., "order", "user")
- **JSON Validation**: Validates and normalizes JSON data before insertion
- **Batch Processing**: Processes data in configurable batches (default: 1000 rows)
- **Error Recovery**: Uses savepoints to skip problematic rows while continuing migration
- **Error Logging**: Generates `migration_errors.json` with detailed error information
- **Manual Insert Generation**: Creates `manual_inserts.sql` for rows that failed migration
- **Auto-increment Handling**: Converts MySQL `auto_increment` to PostgreSQL `serial`/`bigserial`

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.3.0 or higher)
- MySQL database (source)
- PostgreSQL database (target)

## Installation

```bash
bun install
```

## Configuration

Edit the database configurations in `index.ts`:

### MySQL Source Configuration

```typescript
const mysqlConfig = {
  host: "localhost",
  user: "root",
  password: "root",
  database: "app_db",
  port: 3306,
};
```

### PostgreSQL Target Configuration

```typescript
const pgConfig = {
  host: "localhost",
  user: "app_user",
  password: "app_pass",
  database: "anuj_prokashon_production2",
  port: 5432,
};
```

### Migration Options

```typescript
const OPTIONS = {
  skipOnError: true, // Continue migration even if individual rows fail
  batchSize: 1000, // Number of rows to process per batch
};
```

## Usage

Run the migration:

```bash
bun run index.ts
```

## Migration Process

The tool performs the following steps:

1. **Connect** to both MySQL and PostgreSQL databases
2. **Discover** all tables in the MySQL database
3. **For each table**:
   - Retrieve column definitions from MySQL
   - Create corresponding table in PostgreSQL with mapped types
   - Migrate data in batches
   - Use savepoints for row-level error recovery
4. **Generate Reports**:
   - `migration_errors.json`: Detailed error log
   - `manual_inserts.sql`: SQL statements for failed rows

## Type Mapping

| MySQL Type                 | PostgreSQL Type            |
| -------------------------- | -------------------------- |
| `tinyint`                  | `smallint`                 |
| `int`                      | `integer`                  |
| `bigint`                   | `bigint`                   |
| `float`                    | `real`                     |
| `double`                   | `double precision`         |
| `decimal/numeric`          | `numeric`                  |
| `datetime/timestamp`       | `timestamp`                |
| `varchar/char`             | `varchar/char` (with size) |
| `text/longtext/mediumtext` | `text`                     |
| `tinyint(1)/bool`          | `boolean`                  |
| `json`                     | `jsonb`                    |
| `blob/binary`              | `bytea`                    |
| `enum/set`                 | `text`                     |
| `auto_increment (int)`     | `serial`                   |
| `auto_increment (bigint)`  | `bigserial`                |

## Output Files

### migration_errors.json

Contains detailed information about any errors encountered:

```json
[
  {
    "type": "row_skipped",
    "table": "users",
    "rowIndex": 42,
    "error": "invalid input syntax for type json",
    "rowData": { ... }
  }
]
```

### manual_inserts.sql

Contains SQL INSERT statements for rows that failed during migration:

```sql
-- Row 42 from users
INSERT INTO "users" ("id", "name", "email") VALUES (42, 'John Doe', 'john@example.com') ON CONFLICT DO NOTHING;
```

## Error Handling

- **Row-level errors**: When `skipOnError: true`, failed rows are logged and skipped
- **Table-level errors**: If a table fails completely, it's logged and the migration continues
- **Savepoints**: Each row is wrapped in a savepoint for granular rollback
- **Batch commits**: Successful rows are committed in batches

## Troubleshooting

### JSON Errors

If you encounter JSON parsing errors, check the `migration_errors.json` file. Invalid JSON values are automatically converted to `null`.

### Reserved Keywords

Column names that are PostgreSQL reserved keywords are automatically quoted. If you see errors related to syntax, verify the generated SQL.

### Manual Recovery

Use the generated `manual_inserts.sql` file to manually insert rows that failed:

```bash
psql -U app_user -d anuj_prokashon_production2 -f manual_inserts.sql
```

## Development

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## License

MIT
