import type { Pool, PoolClient } from 'pg';
import { getTenantContext } from './context.js';
import type { OwnershipColumns } from './ownership.js';
import { TenantScopedRepository } from './repository.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

/**
 * Runs fn inside a transaction with the tenant GUC set from the AMBIENT
 * context (spec 01 §3, db/README.md) — RLS policies key on it. The value is
 * bound via set_config($1), never interpolated. No context → throws (fail
 * closed) before any SQL runs.
 */
export async function withPgTenantTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = getTenantContext();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Postgres-backed tenant repository. Two layers of isolation apply: RLS at
 * the database (the query runs under the tenant GUC) and the base class's
 * application-level re-assertion of tenant_id on every returned row.
 */
export class PgTenantRepository<
  T extends OwnershipColumns & { id: string },
> extends TenantScopedRepository<T> {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    resourceName: string,
    table: string,
  ) {
    super(resourceName);
    this.table = assertIdentifier(table);
  }

  protected fetchById(_tenantId: string, id: string): Promise<T | undefined> {
    return withPgTenantTransaction(this.pool, async (client) => {
      const { rows } = await client.query<T>(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
      return rows[0];
    });
  }

  /**
   * Inserts a row; ownership columns come from the ambient context (via SQL
   * defaults + explicit tenant columns), never from `data`.
   */
  insert(data: Readonly<Record<string, unknown>>): Promise<T> {
    const ctx = getTenantContext();
    const entries = Object.entries(data).filter(
      ([key]) =>
        !['tenant_id', 'organization_id', 'created_by', 'created_at', 'updated_at'].includes(key),
    );
    const columns = [
      'tenant_id',
      'organization_id',
      'created_by',
      ...entries.map(([key]) => assertIdentifier(key)),
    ];
    const values: unknown[] = [ctx.tenantId, ctx.organizationId, ctx.actor.id];
    values.push(...entries.map(([, value]) => value));
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    return withPgTenantTransaction(this.pool, async (client) => {
      const { rows } = await client.query<T>(
        `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return rows[0] as T;
    });
  }

  list(): Promise<T[]> {
    return withPgTenantTransaction(this.pool, async (client) => {
      const { rows } = await client.query<T>(`SELECT * FROM ${this.table}`);
      return rows;
    });
  }
}
