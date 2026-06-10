/**
 * Project Scope Enforcement
 *
 * authMiddleware resolves each API key to exactly one project (authContext.projectName)
 * and overwrites the X-Project-Name header with it — but the tenant identifiers carried
 * in request bodies, query strings, and route params were never checked against it. Any
 * valid key could therefore read or destroy another tenant's data by naming its
 * collection/project (e.g. {collection: "victim_agent_memory"}, or
 * GET /api/collections/victim_codebase/scroll). These guards close that hole.
 *
 * Naming convention (matches existing code, e.g. search.ts `collection.split('_')[0]`):
 * collections are `${project}_${type}` and project names use hyphens, never a leading
 * underscore-prefix of another live project. Enforcement is skipped for unauthenticated
 * (anonymous/dev or legacy single-shared-key) requests — those are a single trust domain
 * with no per-key project to scope to.
 *
 * Coverage:
 *  - enforceProjectScope: app-level guard for body.collection / body.projectName and
 *    query.project / query.projectName (these are available before route matching).
 *  - scopeCollectionParam / scopeProjectParam: router.param() callbacks for route params
 *    (:name/:collection are collections, :project is a project) — req.params is only
 *    populated at route-match time, so path params must be guarded at the router level.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/** A collection belongs to a project iff it equals `${project}` or starts with `${project}_`. */
export function collectionBelongsToProject(collection: string, project: string): boolean {
  return collection === project || collection.startsWith(`${project}_`);
}

function deny(req: Request, res: Response, project: string, detail: string) {
  logger.warn('Project scope violation blocked', {
    authProject: project,
    keyName: req.authContext?.keyName,
    method: req.method,
    path: req.path,
    detail,
  });
  res.status(403).json({
    error: `Request targets a project you are not authorized for (authenticated as "${project}")`,
    code: 'PROJECT_SCOPE_VIOLATION',
  });
}

/** App-level guard: validates body + query tenant identifiers. */
export function enforceProjectScope(req: Request, res: Response, next: NextFunction) {
  const ctx = req.authContext;
  // Only enforce when a real key resolved a project. Anonymous/legacy requests are
  // header-derived (a single shared trust domain) and have nothing to scope against.
  if (!ctx?.authenticated) return next();

  const project = ctx.projectName;
  const violations: string[] = [];

  const body = req.body;
  if (body && typeof body === 'object') {
    if (
      typeof body.collection === 'string' &&
      !collectionBelongsToProject(body.collection, project)
    ) {
      violations.push(`body.collection="${body.collection}"`);
    }
    if (typeof body.projectName === 'string' && body.projectName !== project) {
      violations.push(`body.projectName="${body.projectName}"`);
    }
  }

  const q = req.query;
  if (typeof q.project === 'string' && q.project !== project) {
    violations.push(`query.project="${q.project}"`);
  }
  if (typeof q.projectName === 'string' && q.projectName !== project) {
    violations.push(`query.projectName="${q.projectName}"`);
  }
  if (typeof q.collection === 'string' && !collectionBelongsToProject(q.collection, project)) {
    violations.push(`query.collection="${q.collection}"`);
  }

  if (violations.length > 0) {
    return deny(req, res, project, violations.join(', '));
  }
  next();
}

/**
 * router.param() callback for params that name a COLLECTION (:name, :collection).
 * Register once per param name on a router; it fires for every route using that param.
 */
export function scopeCollectionParam(
  req: Request,
  res: Response,
  next: NextFunction,
  value: string
) {
  const ctx = req.authContext;
  if (!ctx?.authenticated) return next();
  if (typeof value === 'string' && !collectionBelongsToProject(value, ctx.projectName)) {
    return deny(req, res, ctx.projectName, `param collection="${value}"`);
  }
  next();
}

/** router.param() callback for params that name a PROJECT (:project). */
export function scopeProjectParam(req: Request, res: Response, next: NextFunction, value: string) {
  const ctx = req.authContext;
  if (!ctx?.authenticated) return next();
  if (typeof value === 'string' && value !== ctx.projectName) {
    return deny(req, res, ctx.projectName, `param project="${value}"`);
  }
  next();
}
