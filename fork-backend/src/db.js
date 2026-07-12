import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(dataDir, 'fork.json')

function emptyDb() {
  return {
    admins: [],
    plans: [],
    subscription_sources: [],
    users: [],
    announcements: [],
    orders: [],
    coupons: [],
    settings: {},
  }
}

function load() {
  if (!fs.existsSync(dbPath)) {
    const data = emptyDb()
    save(data)
    return data
  }
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) }
  } catch {
    const data = emptyDb()
    save(data)
    return data
  }
}

function save(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8')
}

export const db = {
  read() {
    return load()
  },
  write(mutator) {
    const data = load()
    const result = mutator(data)
    save(data)
    return result
  },
  path: dbPath,
}

export function nowTs() {
  return Math.floor(Date.now() / 1000)
}
