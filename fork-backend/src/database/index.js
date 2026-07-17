import pg from 'pg'

const { Pool } = pg
let pool = null

export function databaseUrl() {
  return String(process.env.DATABASE_URL || process.env.FORK_DATABASE_URL || '').trim()
}

export function isPostgresConfigured() {
  return Boolean(databaseUrl())
}

export function getPool() {
  const connectionString = databaseUrl()
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL operations')
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Math.max(1, Number(process.env.FORK_DB_POOL_MAX || 10)),
      ssl:
        String(process.env.FORK_DB_SSL || '').toLowerCase() === 'require'
          ? { rejectUnauthorized: String(process.env.FORK_DB_SSL_REJECT_UNAUTHORIZED || 'true') !== 'false' }
          : undefined,
    })
  }
  return pool
}

export async function withTransaction(work) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  } finally {
    client.release()
  }
}

export async function databaseHealth() {
  if (!isPostgresConfigured()) {
    return { configured: false, ok: false, detail: 'DATABASE_URL is not configured' }
  }
  try {
    const result = await getPool().query('SELECT NOW() AS now')
    return { configured: true, ok: true, now: result.rows[0]?.now || null }
  } catch (error) {
    return { configured: true, ok: false, detail: error.message }
  }
}

export async function closeDatabase() {
  if (pool) {
    const current = pool
    pool = null
    await current.end()
  }
}
