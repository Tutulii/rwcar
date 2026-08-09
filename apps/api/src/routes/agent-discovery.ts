import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { RWCAR_MCP_TOOLS } from './mcp.js';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../skills/rwcar-agent');
const ReferenceParams = z.object({
  name: z.enum(['workflows.md', 'tool-contracts.md', 'errors-and-recovery.md']),
});

function endpoint(issuer: string, path: string) {
  return new URL(path, issuer.endsWith('/') ? issuer : `${issuer}/`).toString();
}

async function skillFile(relative: string) {
  return readFile(resolve(skillRoot, relative), 'utf8');
}

export function buildAgentDiscovery(config: ApiConfig, manifest: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    name: 'RWCAR Institutional Agent API',
    environment: new URL(config.CLEANVERSE_BASE_URL).hostname.toLowerCase().includes('uat') ? 'UAT' : 'PRODUCTION',
    chain: { namespace: 'eip155', chainId: 10_143, name: 'Monad Testnet' },
    resource: config.AGENT_AUDIENCE,
    mcp: endpoint(config.AGENT_ISSUER_URL, 'mcp'),
    oauth: {
      authorizationServerMetadata: endpoint(config.AGENT_ISSUER_URL, '.well-known/oauth-authorization-server'),
      protectedResourceMetadata: endpoint(config.AGENT_ISSUER_URL, '.well-known/oauth-protected-resource/mcp'),
      tokenEndpoint: endpoint(config.AGENT_ISSUER_URL, 'oauth/token'),
      grantTypes: ['client_credentials'],
    },
    openapi: endpoint(config.AGENT_ISSUER_URL, 'openapi.json'),
    events: {
      feed: endpoint(config.AGENT_ISSUER_URL, 'agent/v1/events'),
      stream: endpoint(config.AGENT_ISSUER_URL, 'agent/v1/events/stream'),
      protocol: 'SSE',
      cursor: 'Last event UUID returned by the feed or SSE id field',
    },
    skill: {
      manifest: endpoint(config.AGENT_ISSUER_URL, 'agent-skill/manifest.json'),
      instructions: endpoint(config.AGENT_ISSUER_URL, 'agent-skill/SKILL.md'),
      ...manifest,
    },
    capabilities: {
      toolCount: RWCAR_MCP_TOOLS.length,
      tools: RWCAR_MCP_TOOLS,
      arbitraryTransactions: false,
      prepareBeforeExecute: true,
      humanApprovalGates: true,
      executionModes: ['AUTONOMOUS', 'SUPERVISED'],
      autonomousMandate: {
        oneTimeAdministratorSignature: true,
        perIntentHumanApproval: false,
        boundedBySignedConstraints: true,
      },
    },
  };
}

export function registerAgentDiscoveryRoutes(app: FastifyInstance, config: ApiConfig) {
  app.get('/agent-discovery.json', { schema: { hide: true } }, async (_request, reply) => {
    const manifest = JSON.parse(await skillFile('manifest.json')) as Record<string, unknown>;
    reply.header('Cache-Control', 'public, max-age=300');
    return buildAgentDiscovery(config, manifest);
  });

  app.get('/agent-skill/manifest.json', { schema: { hide: true } }, async (_request, reply) => {
    reply.type('application/json; charset=utf-8').header('Cache-Control', 'public, max-age=300');
    return JSON.parse(await skillFile('manifest.json')) as Record<string, unknown>;
  });

  app.get('/agent-skill/SKILL.md', { schema: { hide: true } }, async (_request, reply) => {
    reply.type('text/markdown; charset=utf-8').header('Cache-Control', 'public, max-age=300');
    return reply.send(await skillFile('SKILL.md'));
  });

  app.get('/agent-skill/references/:name', {
    schema: { hide: true, params: ReferenceParams },
  }, async (request, reply) => {
    const { name } = request.params as z.infer<typeof ReferenceParams>;
    reply.type('text/markdown; charset=utf-8').header('Cache-Control', 'public, max-age=300');
    return reply.send(await skillFile(`references/${name}`));
  });

  app.get('/docs/agents', { schema: { hide: true } }, async (_request, reply) => {
    return reply.redirect('/agent-discovery.json');
  });
}
