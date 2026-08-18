import { logger } from './utils/logger';
import swaggerUi from 'swagger-ui-express';
import type { Express, Request, Response, NextFunction } from 'express';
import { generateOpenApiDocument } from './openapi-registry';
import './routes/contracts/demands-contracts';
import './routes/contracts/governance-contracts';
import './routes/contracts/cognitive-contracts';
import './routes/contracts/admin-contracts';

export function setupSwagger(app: Express) {
  // Regenerate document dynamically when route is hit (or once on startup, depending on preference)
  app.use('/api-docs', swaggerUi.serve, (req: Request, res: Response, next: NextFunction) => {
    // Generate the document dynamically so that all routes registered after setupSwagger are included
    const swaggerDocument = generateOpenApiDocument();
    swaggerUi.setup(swaggerDocument, { explorer: true })(req, res, next);
  });
  logger.info('Swagger documentation available at /api-docs');
}
