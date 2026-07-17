import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-backend-persistence-'))
process.env.FORK_DATA_DIR = tempDir
const { db } = await import(`../src/db.js?persistence-test=${Date.now()}`)
const backup = await import(`../src/backup.js?persistence-test=${Date.now()}`)

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('writes validated database data atomically and preserves a snapshot', () => {
  const before = db.read()
  assert.equal(before.schema_version, 1)

  db.write((data) => {
    data.users.push({ id: 'user-1', username: 'tester' })
  })

  const after = db.read()
  assert.equal(after.users.length, 1)
  assert.equal(after.users[0].username, 'tester')
  assert.equal(fs.existsSync(db.path), true)
})

test('creates verifiable backups and restores through the atomic database writer', () => {
  const created = backup.createBackup(db.path, 'test')
  assert.equal(created.verified, undefined)
  assert.equal(created.sha256.length, 64)

  db.write((data) => {
    data.users.length = 0
  })
  assert.equal(db.read().users.length, 0)

  backup.restoreBackup(db.path, created.name)
  assert.equal(db.read().users.length, 1)
  assert.equal(backup.listBackups()[0].verified, true)
})

test('refuses to replace a corrupt database with an empty database', () => {
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-backend-corrupt-'))
  try {
    fs.writeFileSync(path.join(corruptDir, 'fork.json'), '{not json', 'utf8')
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', "import('./src/db.js').then(({db}) => db.read())"],
      {
        cwd: path.resolve('D:/clash/fork-backend'),
        env: { ...process.env, FORK_DATA_DIR: corruptDir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    assert.fail(`Expected corrupt database process to fail: ${output}`)
  } catch (error) {
    assert.notEqual(error.status, 0)
    assert.equal(fs.readFileSync(path.join(corruptDir, 'fork.json'), 'utf8'), '{not json')
  } finally {
    fs.rmSync(corruptDir, { recursive: true, force: true })
  }
})
