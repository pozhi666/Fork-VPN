import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
// config.js loads .env as side effect before secret resolution
import { getJwtExpires, resolveJwtSecret } from './config.js'

const JWT_SECRET = resolveJwtSecret()
const JWT_EXPIRES = getJwtExpires()

export function signUserToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: 'user',
      plan: user.plan_name || user.plan || 'trial',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  )
}

export function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, username: admin.username, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '2h' },
  )
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 12)
}

export function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash)
}

export function authMiddleware(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) {
      return res.status(401).json({ error: '未登录' })
    }
    try {
      const payload = verifyToken(token)
      if (requiredRole && payload.role !== requiredRole) {
        return res.status(403).json({ error: '无权限' })
      }
      req.auth = payload
      next()
    } catch {
      return res.status(401).json({ error: '登录已失效' })
    }
  }
}
