const { verifyAccessToken } = require('../utils/jwt');
const { unauthorized, forbidden } = require('../utils/errors');
const { query } = require('../db/pool');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing or invalid authorization header');
    }

    const token = header.slice(7);
    const payload = verifyAccessToken(token);

    const { rows } = await query(
      `SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );

    if (!rows.length) {
      throw unauthorized('User not found');
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      next(unauthorized('Invalid or expired token'));
      return;
    }
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(forbidden('Insufficient permissions'));
      return;
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
