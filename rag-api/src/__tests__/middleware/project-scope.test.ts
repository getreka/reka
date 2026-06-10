import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  enforceProjectScope,
  scopeCollectionParam,
  scopeProjectParam,
  collectionBelongsToProject,
} from '../../middleware/project-scope';

function mockReqRes(authContext: any, body: any, query: any = {}) {
  const req = {
    authContext,
    body,
    query,
    path: '/search',
    method: 'POST',
  } as unknown as Request;
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, json };
}

describe('collectionBelongsToProject', () => {
  it('accepts the project itself and its own collections', () => {
    expect(collectionBelongsToProject('myapp', 'myapp')).toBe(true);
    expect(collectionBelongsToProject('myapp_codebase', 'myapp')).toBe(true);
    expect(collectionBelongsToProject('myapp_agent_memory', 'myapp')).toBe(true);
    expect(collectionBelongsToProject('demo-alice_memory_semantic', 'demo-alice')).toBe(true);
  });

  it("rejects another project's collections", () => {
    expect(collectionBelongsToProject('other_codebase', 'myapp')).toBe(false);
    expect(collectionBelongsToProject('demo-bob_memory', 'demo-alice')).toBe(false);
    expect(collectionBelongsToProject('myapp', 'myapp_real')).toBe(false);
  });
});

describe('enforceProjectScope', () => {
  it('skips enforcement for unauthenticated (anonymous/dev) requests', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: false, projectName: 'anything' },
      { collection: 'someoneelse_memory' }
    );
    enforceProjectScope(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows access to the key own project collection', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      { collection: 'myapp_codebase', query: 'x' }
    );
    enforceProjectScope(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks cross-tenant collection reads with 403', () => {
    const { req, res, next, json } = mockReqRes(
      { authenticated: true, projectName: 'demo-alice', keyName: 'k1' },
      { collection: 'demo-bob_agent_memory' }
    );
    enforceProjectScope(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROJECT_SCOPE_VIOLATION' }));
  });

  it('blocks a mismatched projectName field with 403', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      { projectName: 'victim', symbol: 'foo' }
    );
    enforceProjectScope(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a matching projectName field', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      { projectName: 'myapp', symbol: 'foo' }
    );
    enforceProjectScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes through when no collection/projectName is supplied', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      { query: 'x' }
    );
    enforceProjectScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks a cross-tenant query.project (?project=victim)', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {},
      { project: 'victim' }
    );
    enforceProjectScope(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows query.project equal to the auth project', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {},
      { project: 'myapp' }
    );
    enforceProjectScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('scopeCollectionParam (router.param)', () => {
  it("blocks another tenant's collection in a route param (e.g. /collections/victim_codebase)", () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {}
    );
    scopeCollectionParam(req, res, next, 'victim_codebase');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows the auth project own collection param', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {}
    );
    scopeCollectionParam(req, res, next, 'myapp_codebase');
    expect(next).toHaveBeenCalled();
  });

  it('skips for unauthenticated requests', () => {
    const { req, res, next } = mockReqRes({ authenticated: false, projectName: 'x' }, {});
    scopeCollectionParam(req, res, next, 'victim_codebase');
    expect(next).toHaveBeenCalled();
  });
});

describe('scopeProjectParam (router.param)', () => {
  it("blocks another tenant's project in a route param (e.g. /patterns/victim)", () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {}
    );
    scopeProjectParam(req, res, next, 'victim');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows the auth project own project param', () => {
    const { req, res, next } = mockReqRes(
      { authenticated: true, projectName: 'myapp', keyName: 'k1' },
      {}
    );
    scopeProjectParam(req, res, next, 'myapp');
    expect(next).toHaveBeenCalled();
  });
});
