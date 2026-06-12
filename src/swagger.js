const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const { port } = require('./config/env');

const SPEC_PATH = path.join(__dirname, '../../docs/openapi.yaml');

function loadOpenApiSpec() {
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  const spec = yaml.load(raw);

  // Ensure local server matches running instance
  const localUrl = `http://localhost:${port}/v1`;
  spec.servers = [
    { url: localUrl, description: 'Local development' },
    ...(spec.servers || []).filter((s) => !s.url.includes('localhost')),
  ];

  return { spec, raw };
}

function setupSwagger(app) {
  const { spec, raw } = loadOpenApiSpec();

  app.get('/docs/openapi.yaml', (_req, res) => {
    res.type('text/yaml').send(raw);
  });

  app.get('/docs/openapi.json', (_req, res) => {
    res.json(spec);
  });

  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Fitnexia API',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
        filter: true,
        tryItOutEnabled: true,
      },
    }),
  );
}

module.exports = { setupSwagger, loadOpenApiSpec };
