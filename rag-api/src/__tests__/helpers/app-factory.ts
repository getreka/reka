import express, { Router } from 'express';
import { errorHandler } from '../../middleware/error-handler';

export function createTestApp(
  ...routes: Array<{ router: Router; prefix?: string }>
): express.Express {
  const app = express();
  app.use(express.json());
  for (const { router, prefix = '/api' } of routes) {
    app.use(prefix, router);
  }
  app.use(errorHandler);
  return app;
}

export function withProject(test: any, name = 'test'): any {
  return test.set('X-Project-Name', name);
}
