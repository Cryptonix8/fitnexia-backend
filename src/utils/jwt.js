const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  jwtAccessSecret,
  jwtRefreshSecret,
  jwtAccessExpiresIn,
} = require('../config/env');

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    jwtAccessSecret,
    { expiresIn: jwtAccessExpiresIn },
  );
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, jwtRefreshSecret, {
    expiresIn: '30d',
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function verifyAccessToken(token) {
  return jwt.verify(token, jwtAccessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, jwtRefreshSecret);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  hashToken,
  verifyAccessToken,
  verifyRefreshToken,
};
