const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { setupSwagger } = require('./swagger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { frontendUrl } = require('./config/env');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(cors({ origin: frontendUrl === '*' ? true : frontendUrl.split(',') }));
  app.use(express.json({ limit: '1mb' }));

  setupSwagger(app);

  app.use('/v1', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
