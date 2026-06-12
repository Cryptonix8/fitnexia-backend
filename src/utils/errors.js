class AppError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(message = 'Resource not found') {
  return new AppError(404, 'NOT_FOUND', message);
}

function unauthorized(message = 'Unauthorized') {
  return new AppError(401, 'UNAUTHORIZED', message);
}

function forbidden(message = 'Forbidden') {
  return new AppError(403, 'FORBIDDEN', message);
}

function badRequest(message, details = {}) {
  return new AppError(400, 'VALIDATION_ERROR', message, details);
}

function conflict(code, message, details = {}) {
  return new AppError(409, code, message, details);
}

module.exports = { AppError, notFound, unauthorized, forbidden, badRequest, conflict };
