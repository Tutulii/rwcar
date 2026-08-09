import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { AgentService } from '../services/agent.js';

export const TokenBodySchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  scope: z.string().optional(),
  resource: z.string().url(),
});

// Keep the route parser deliberately broad enough to return OAuth-standard
// errors. If Fastify rejected the body first, clients would receive the API's
// generic validation envelope instead of RFC 6749/8707 error fields.
const TokenWireBodySchema = z.object({
  grant_type: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
}).passthrough();

function endpoint(issuer: string, path: string) {
  return new URL(path, issuer.endsWith('/') ? issuer : `${issuer}/`).toString();
}

function basicCredentials(header: string | undefined) {
  if (!header?.startsWith('Basic ')) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return undefined;
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

function oauthError(
  reply: FastifyReply,
  statusCode: number,
  error: 'invalid_request' | 'invalid_client' | 'invalid_scope' | 'invalid_target' | 'unsupported_grant_type' | 'temporarily_unavailable',
  errorDescription: string,
) {
  return reply.status(statusCode).send({ error, error_description: errorDescription });
}

export function registerOAuthRoutes(app: FastifyInstance, config: ApiConfig, service: AgentService) {
  app.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async () => ({
    issuer: config.AGENT_ISSUER_URL,
    token_endpoint: endpoint(config.AGENT_ISSUER_URL, 'oauth/token'),
    jwks_uri: endpoint(config.AGENT_ISSUER_URL, '.well-known/jwks.json'),
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    resource_indicators_supported: true,
    scopes_supported: ['protocol:read', 'vault:write', 'offers:write', 'positions:write', 'auctions:write', 'claims:write', 'margin:write', 'intents:execute'],
  }));

  const protectedResourceMetadata = () => ({
    resource: config.AGENT_AUDIENCE,
    authorization_servers: [config.AGENT_ISSUER_URL],
    bearer_methods_supported: ['header'],
    resource_documentation: endpoint(config.AGENT_ISSUER_URL, 'agent-discovery.json'),
    scopes_supported: ['protocol:read', 'vault:write', 'offers:write', 'positions:write', 'auctions:write', 'claims:write', 'margin:write', 'intents:execute'],
  });
  app.get('/.well-known/oauth-protected-resource', { schema: { hide: true } }, protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', { schema: { hide: true } }, protectedResourceMetadata);

  app.get('/.well-known/jwks.json', { schema: { hide: true } }, async () => {
    service.assertEnabled();
    return service.jwt!.jwks();
  });

  app.post('/oauth/token', {
    schema: { hide: true, body: TokenWireBodySchema },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    const parsed = TokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const wire = request.body as z.infer<typeof TokenWireBodySchema>;
      if (wire.grant_type && wire.grant_type !== 'client_credentials') {
        return oauthError(reply, 400, 'unsupported_grant_type', 'Only the client_credentials grant is supported');
      }
      return oauthError(reply, 400, 'invalid_request', 'grant_type and the canonical MCP resource URI are required');
    }
    const body = parsed.data;
    const basic = basicCredentials(request.headers.authorization);
    if (request.headers.authorization && !basic) {
      reply.header('WWW-Authenticate', 'Basic realm="rwcar-agent-token", error="invalid_client"');
      return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    }
    if (basic && (body.client_id || body.client_secret)) {
      return oauthError(reply, 400, 'invalid_request', 'Use exactly one client authentication method');
    }
    const clientId = basic?.clientId ?? body.client_id;
    const clientSecret = basic?.clientSecret ?? body.client_secret;
    if (!clientId || !clientSecret) {
      reply.header('WWW-Authenticate', 'Basic realm="rwcar-agent-token"');
      return oauthError(reply, 401, 'invalid_client', 'Client authentication is required');
    }
    try {
      return await service.issueToken(clientId, clientSecret, body.resource, body.scope?.split(/\s+/).filter(Boolean));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'INVALID_CLIENT') {
        reply.header('WWW-Authenticate', 'Basic realm="rwcar-agent-token", error="invalid_client"');
        return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
      }
      if (error.code === 'INVALID_SCOPE') return oauthError(reply, 400, 'invalid_scope', error.message);
      if (error.code === 'INVALID_TARGET_RESOURCE') return oauthError(reply, 400, 'invalid_target', error.message);
      if (error.code === 'AGENT_PLATFORM_DISABLED') return oauthError(reply, 503, 'temporarily_unavailable', error.message);
      throw error;
    }
  });
}
