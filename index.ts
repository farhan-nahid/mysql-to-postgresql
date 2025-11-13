/**
 * MySQL to PostgreSQL Migration Script
 * 
 * Features:
 * - Handles JSON type conversion and validation
 * - Escapes reserved keywords (e.g., "order")
 * - Generates manual_inserts.sql for skipped rows
 * - Batch processing with error recovery
 * 
 * Usage: bun run index.ts
 */

import * as fs from 'fs';
import mysql from 'mysql2/promise';
import * as path from 'path';
import { Pool, type PoolClient } from 'pg';

/** MySQL source database configuration */
const mysqlConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'app_db',
  port: 3306,
};

/** PostgreSQL target database configuration */
const pgConfig = {
  host: 'localhost',
  user: 'app_user',
  password: 'app_pass',
  database: 'app_db',
  port: 5432,
};

/** Migration behavior options */
const OPTIONS = {
  skipOnError: true,
  batchSize: 1000,
};

const ERROR_FILE = path.join(__dirname, 'migration_errors.json');
const MANUAL_SQL_FILE = path.join(__dirname, 'manual_inserts.sql');

let errors: any[] = [];

/** Maps MySQL data types to PostgreSQL equivalents */
const typeMap: { [key: string]: string } = {
  'tinyint': 'smallint',
  'smallint': 'smallint',
  'mediumint': 'integer',
  'int': 'integer',
  'bigint': 'bigint',
  'float': 'real',
  'double': 'double precision',
  'decimal': 'numeric',
  'numeric': 'numeric',
  'date': 'date',
  'time': 'time',
  'datetime': 'timestamp',
  'timestamp': 'timestamp',
  'varchar': 'varchar',
  'char': 'char',
  'text': 'text',
  'longtext': 'text',
  'mediumtext': 'text',
  'tinyint(1)': 'boolean',
  'bool': 'boolean',
  'boolean': 'boolean',
  'enum': 'text',
  'set': 'text',
  'blob': 'bytea',
  'varbinary': 'bytea',
  'binary': 'bytea',
  'json': 'jsonb',
  'year': 'smallint',
};

/**
 * Converts MySQL data type to PostgreSQL data type
 * @param dataType - Base MySQL data type
 * @param columnType - Full column type definition
 * @param isUnsigned - Whether the column is unsigned
 * @param extra - Extra column attributes (e.g., auto_increment)
 */
function mapMySQLType(dataType: string, columnType: string, isUnsigned: boolean = false, extra: string = ''): string {
  let baseType = dataType.toLowerCase().replace(/\(\d+(,\d+)?\)/, '');
  let pgType = typeMap[baseType] || 'text';
  if (isUnsigned && pgType === 'smallint') pgType = 'integer';
  if (isUnsigned && pgType === 'integer') pgType = 'bigint';
  if (extra.includes('auto_increment')) {
    if (pgType === 'integer') return 'serial';
    if (pgType === 'bigint') return 'bigserial';
  }
  const match = columnType.match(/(\w+)\((\d+)\)/);
  if (match && (baseType === 'varchar' || baseType === 'char')) {
    return `${pgType}(${match[2]})`;
  }
  if (baseType === 'decimal' || baseType === 'numeric') {
    const match = columnType.match(/(\w+)\((\d+),(\d+)\)/);
    if (match) {
      return `${pgType}(${match[2]},${match[3]})`;
    }
  }
  return pgType;
}

/**
 * Normalizes a value to a valid JSON string for PostgreSQL insertion
 * @param val - Value to normalize (can be string, object, or other types)
 * @returns Valid JSON string or 'null'
 */
function normalizeJsonValue(val: any): string {
  if (val === null || val === undefined) return 'null';
  let jsonObj: any;
  if (typeof val === 'string') {
    try {
      jsonObj = JSON.parse(val);
    } catch (e) {
      console.warn(`⚠️ Invalid JSON string: ${val.substring(0, 100)}... (using null)`);
      return 'null';
    }
  } else if (typeof val === 'object' && val !== null) {
    jsonObj = val;
  } else {
    return 'null';
  }
  try {
    return JSON.stringify(jsonObj);
  } catch (e: any) {
    console.warn(`⚠️ JSON stringify failed: ${e.message} (using null)`);
    return 'null';
  }
}

async function getTables(mysqlPool: mysql.Pool): Promise<string[]> {
  const [rows] = await mysqlPool.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [mysqlConfig.database]
  );
  return (rows as any[]).map(row => row.TABLE_NAME);
}

async function getColumns(mysqlPool: mysql.Pool, tableName: string): Promise<any[]> {
  const [rows] = await mysqlPool.execute(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [mysqlConfig.database, tableName]
  );
  return rows as any[];
}

/**
 * Generates CREATE TABLE SQL with quoted column names to handle reserved keywords
 * @param tableName - Name of the table to create
 * @param columns - Array of column definitions from MySQL
 */
function generateCreateTableSQL(tableName: string, columns: any[]): string {
  const quotedCols = columns.map(col => {
    const quotedName = `"${col.COLUMN_NAME}"`;
    const pgType = mapMySQLType(col.DATA_TYPE, col.COLUMN_TYPE, col.COLUMN_TYPE.includes('unsigned'), col.EXTRA);
    const nullable = col.IS_NULLABLE === 'YES' ? '' : ' NOT NULL';
    const defaultVal = col.COLUMN_DEFAULT ? ` DEFAULT ${col.COLUMN_DEFAULT}` : '';
    const pk = col.COLUMN_KEY === 'PRI' ? ' PRIMARY KEY' : '';
    return `  ${quotedName} ${pgType}${nullable}${defaultVal}${pk}`;
  }).join(',\n');
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${quotedCols}\n);`;
}

async function logError(errorObj: any) {
  errors.push(errorObj);
  console.error(JSON.stringify(errorObj, null, 2));
}

async function migrateTable(client: PoolClient, mysqlPool: mysql.Pool, tableName: string): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  try {
    console.log(`\n🔄 Processing table: ${tableName}`);
    const columns = await getColumns(mysqlPool, tableName);
    const createSQL = generateCreateTableSQL(tableName, columns);
    await client.query(createSQL);
    console.log(` ✅ Created table schema`);

    const jsonColumns = columns.filter(col => col.DATA_TYPE.toLowerCase() === 'json').map(col => col.COLUMN_NAME);
    if (jsonColumns.length > 0) {
      console.log(` 📝 JSON columns: ${jsonColumns.join(', ')}`);
    }

    const [rows] = await mysqlPool.execute(`SELECT * FROM \`${tableName}\``);
    const data = rows as any[];

    if (data.length === 0) {
      console.log(` ⚠️ No data in ${tableName}`);
      return { migrated: 0, skipped: 0 };
    }

    console.log(` 🚀 Migrating ${data.length} rows...`);

    const colNames = columns.map(c => c.COLUMN_NAME);
    const quotedColNames = colNames.map(c => `"${c}"`).join(', ');
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
    const insertQuery = `INSERT INTO "${tableName}" (${quotedColNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    await client.query('BEGIN');

    try {
      const batchSize = OPTIONS.batchSize;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        for (let rowIdx = 0; rowIdx < batch.length; rowIdx++) {
          const row = batch[rowIdx];
          const globalRowIdx = i + rowIdx + 1;

          await client.query(`SAVEPOINT row_sp_${globalRowIdx};`);

          try {
            let values = colNames.map(col => row[col] ?? null);
            // Normalize JSON to strings
            values = values.map((v, idx) => {
              if (jsonColumns.includes(colNames[idx])) {
                return normalizeJsonValue(v);
              }
              return v;
            });
            await client.query(insertQuery, values);
            await client.query(`RELEASE SAVEPOINT row_sp_${globalRowIdx};`);
            migrated++;
          } catch (rowErr: any) {
            await client.query(`ROLLBACK TO SAVEPOINT row_sp_${globalRowIdx};`);
            await client.query(`RELEASE SAVEPOINT row_sp_${globalRowIdx};`);

            if (OPTIONS.skipOnError) {
              skipped++;
              const errorObj = {
                type: 'row_skipped',
                table: tableName,
                rowIndex: globalRowIdx,
                error: rowErr.message,
                rowData: row
              };
              await logError(errorObj);
              console.error(` ❌ Skipped row ${globalRowIdx} in ${tableName}: ${rowErr.message}`);
            } else {
              const errorObj = {
                type: 'table_failed',
                table: tableName,
                rowIndex: globalRowIdx,
                error: `Row ${globalRowIdx} failed: ${rowErr.message}`,
                rowData: row
              };
              await logError(errorObj);
              throw new Error(errorObj.error);
            }
          }
        }
        console.log(` 📦 Batch complete: ${Math.min(i + batchSize, data.length)}/${data.length} (migrated: ${migrated}, skipped: ${skipped})`);
      }

      await client.query('COMMIT');
      console.log(` 🎉 Completed ${tableName}: ${migrated} migrated, ${skipped} skipped`);

    } catch (tableErr: any) {
      await client.query('ROLLBACK');
      console.error(` ❌ Table ${tableName} failed: ${tableErr.message}`);
      const errorObj = {
        type: 'table_failed',
        table: tableName,
        error: tableErr.message
      };
      await logError(errorObj);
      throw tableErr;
    }

    return { migrated, skipped };

  } catch (error) {
    console.error(`❌ Error in ${tableName}:`, error);
    const errorObj = {
      type: 'table_skipped',
      table: tableName,
      error: error instanceof Error ? error.message : String(error)
    };
    await logError(errorObj);
    return { migrated: 0, skipped: 0 };
  }
}

// NEW: Generate manual SQL INSERTs from errors.json
function generateManualInserts() {
  if (!fs.existsSync(ERROR_FILE)) {
    console.log('ℹ️ No errors.json found; skipping manual SQL generation.');
    return;
  }
  const errorsData = JSON.parse(fs.readFileSync(ERROR_FILE, 'utf8'));
  const skippedRows = errorsData.filter((e: any) => e.type === 'row_skipped');
  let sql = `-- Manual INSERT statements for skipped rows\n-- Run these in your PG DB to insert missing data\n-- Generated on ${new Date().toISOString()}\n\n`;

  skippedRows.forEach((err: any, idx: number) => {
    const { table, rowData } = err;
    const columns = Object.keys(rowData);
    const quotedCols = columns.map(c => `"${c}"`).join(', ');
    const values = columns.map(c => {
      let val = rowData[c];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
      if (typeof val === 'number' || typeof val === 'boolean') return val.toString();
      if (Array.isArray(val) || (typeof val === 'object' && val !== null)) return `'${JSON.stringify(val)}'`;
      return val.toString();
    }).join(', ');
    sql += `-- Row ${err.rowIndex} from ${table}\n`;
    sql += `INSERT INTO "${table}" (${quotedCols}) VALUES (${values}) ON CONFLICT DO NOTHING;\n\n`;
  });

  fs.writeFileSync(MANUAL_SQL_FILE, sql);
  console.log(`📄 Generated ${skippedRows.length} manual INSERTs in: ${MANUAL_SQL_FILE}`);
}

async function migrateFullDatabase() {
  let mysqlPool: mysql.Pool | null = null;
  let pgPool: Pool | null = null;
  let totalMigrated = 0;
  let totalSkipped = 0;
  const skippedTables: string[] = [];

  try {
    mysqlPool = mysql.createPool(mysqlConfig);
    pgPool = new Pool(pgConfig);
    console.log(`✅ Connected to MySQL: ${mysqlConfig.database}`);
    console.log(`✅ Connected to PostgreSQL: ${pgConfig.database}`);

    const tables = await getTables(mysqlPool);
    console.log(`📋 Found ${tables.length} tables: ${tables.join(', ')}`);

    const client: PoolClient = await pgPool.connect();

    try {
      for (const tableName of tables) {
        try {
          const { migrated, skipped } = await migrateTable(client, mysqlPool, tableName);
          totalMigrated += migrated;
          totalSkipped += skipped;
        } catch (err) {
          skippedTables.push(tableName);
          console.error(`❌ Skipped entire table ${tableName} due to error`);
        }
      }

      console.log(`\n🎊 Full migration complete! Total: ${totalMigrated} rows migrated, ${totalSkipped} row skips.`);
      if (skippedTables.length > 0) {
        console.log(`⚠️ Skipped tables: ${skippedTables.join(', ')}`);
      }

    } finally {
      client.release();
    }

  } catch (error) {
    console.error('❌ Overall error:', error);
  } finally {
    if (mysqlPool) await mysqlPool.end();
    if (pgPool) await pgPool.end();
    console.log('🔌 Connections closed.');

    if (errors.length > 0) {
      fs.writeFileSync(ERROR_FILE, JSON.stringify(errors, null, 2));
      console.log(`📄 Errors logged to: ${ERROR_FILE}`);
    }

    generateManualInserts();
  }
}

migrateFullDatabase().catch(console.error);