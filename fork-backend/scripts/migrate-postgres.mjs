import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { closeDatabase, getPool, withTransaction } from '../src/database/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations')

const files = fs
  .readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()

try {
  await withTransaction(async (client) => {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    )
    const applied = new Set(
      (await client.query('SELECT id FROM schema_migrations')).rows.map((row) => row.id),
    )

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 12)
      const id = `${file}:${checksum}`
      if (applied.has(id)) continue
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id])
      console.log(`Applied ${file}`)
    }
  })
  await getPool().query('SELECT 1')
  console.log('PostgreSQL migrations complete')
} finally {
  await closeDatabase()
}
