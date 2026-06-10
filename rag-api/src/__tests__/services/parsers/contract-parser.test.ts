import { describe, it, expect, beforeEach } from 'vitest';
import { ContractParser } from '../../../services/parsers/contract-parser';

describe('ContractParser', () => {
  let parser: ContractParser;

  beforeEach(() => {
    parser = new ContractParser();
  });

  describe('canParse()', () => {
    it.each(['.proto', '.graphql', '.gql'])('returns true for %s files', (ext) => {
      expect(parser.canParse(`schema${ext}`)).toBe(true);
    });

    it.each([
      'openapi.yaml',
      'openapi.json',
      'swagger.yaml',
      'swagger.json',
      'my-openapi-spec.yml',
      'api-swagger-v2.json',
    ])('returns true for OpenAPI/Swagger file: %s', (filename) => {
      expect(parser.canParse(filename)).toBe(true);
    });

    it.each(['.ts', '.js', '.json', '.yaml', '.py'])('returns false for %s files', (ext) => {
      expect(parser.canParse(`file${ext}`)).toBe(false);
    });
  });

  describe('parse() — Proto', () => {
    const protoContent = `syntax = "proto3";

message User {
  string id = 1;
  string name = 2;
}

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
}

enum Role {
  ADMIN = 0;
  USER = 1;
}`;

    it('chunks by message, service, and enum blocks', () => {
      const chunks = parser.parse(protoContent, 'api.proto');
      expect(chunks).toHaveLength(3);
    });

    it('extracts symbols from block names', () => {
      const chunks = parser.parse(protoContent, 'api.proto');
      const symbols = chunks.flatMap((c) => c.symbols || []);
      expect(symbols).toContain('User');
      expect(symbols).toContain('UserService');
      expect(symbols).toContain('Role');
    });

    it('sets language to protobuf', () => {
      const chunks = parser.parse(protoContent, 'api.proto');
      for (const chunk of chunks) {
        expect(chunk.language).toBe('protobuf');
        expect(chunk.type).toBe('contract');
      }
    });

    it('tracks line numbers', () => {
      const chunks = parser.parse(protoContent, 'api.proto');
      expect(chunks[0].startLine).toBeGreaterThan(0);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[0].startLine);
    });

    it('returns fallback chunk for content with no blocks', () => {
      const chunks = parser.parse('syntax = "proto3";', 'empty.proto');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('protobuf');
    });
  });

  describe('parse() — GraphQL', () => {
    const gqlContent = `type User {
  id: ID!
  name: String!
}

input CreateUserInput {
  name: String!
}

enum Role {
  ADMIN
  USER
}

query GetUser {
  user(id: ID!): User
}

mutation CreateUser {
  createUser(input: CreateUserInput!): User
}`;

    it('chunks by type, input, enum, query, mutation', () => {
      const chunks = parser.parse(gqlContent, 'schema.graphql');
      expect(chunks).toHaveLength(5);
    });

    it('extracts symbols', () => {
      const chunks = parser.parse(gqlContent, 'schema.graphql');
      const symbols = chunks.flatMap((c) => c.symbols || []);
      expect(symbols).toContain('User');
      expect(symbols).toContain('CreateUserInput');
      expect(symbols).toContain('Role');
      expect(symbols).toContain('GetUser');
      expect(symbols).toContain('CreateUser');
    });

    it('sets language to graphql', () => {
      const chunks = parser.parse(gqlContent, 'schema.graphql');
      for (const chunk of chunks) {
        expect(chunk.language).toBe('graphql');
      }
    });

    it('works with .gql extension', () => {
      const chunks = parser.parse(gqlContent, 'schema.gql');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].language).toBe('graphql');
    });

    it('returns fallback for empty graphql', () => {
      const chunks = parser.parse('# just a comment', 'schema.graphql');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].language).toBe('graphql');
    });
  });

  describe('parse() — OpenAPI', () => {
    const yamlOpenAPI = `openapi: "3.0.0"
info:
  title: Test API
  version: "1.0"
paths:
  /users:
    get:
      summary: List users
components:
  schemas:
    User:
      type: object`;

    it('chunks YAML by top-level keys', () => {
      const chunks = parser.parse(yamlOpenAPI, 'openapi.yaml');
      expect(chunks.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts top-level key names as symbols', () => {
      const chunks = parser.parse(yamlOpenAPI, 'openapi.yaml');
      const symbols = chunks.flatMap((c) => c.symbols || []);
      expect(symbols).toContain('openapi');
      expect(symbols).toContain('paths');
      expect(symbols).toContain('components');
    });

    it('sets language to yaml for .yaml files', () => {
      const chunks = parser.parse(yamlOpenAPI, 'openapi.yaml');
      for (const chunk of chunks) {
        expect(chunk.language).toBe('yaml');
      }
    });

    it('sets language to json for .json files', () => {
      const jsonContent = '{\n  "openapi": "3.0.0"\n}';
      const chunks = parser.parse(jsonContent, 'openapi.json');
      for (const chunk of chunks) {
        expect(chunk.language).toBe('json');
      }
    });

    it('handles swagger filenames', () => {
      const chunks = parser.parse(yamlOpenAPI, 'swagger.yml');
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('parse() — fallback routing', () => {
    it('returns contract-type fallback chunk for unknown contract format', () => {
      // A file matching canParse but not matching any specific parser
      // This won't happen in practice since canParse already filters, but tests the default branch
      const chunks = parser.parse('some content', 'openapi-spec.txt');
      // Since .txt extension won't match proto/gql and "openapi" is in the name
      // but extname is .txt, it falls through to OpenAPI parser
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
