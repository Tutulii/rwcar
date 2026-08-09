import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import { createDatabase } from '@rwcar/db';
import Fastify from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ApiConfig } from './config.js';
import { AppError } from './errors.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerV2Routes } from './routes/v2.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerAgentDiscoveryRoutes } from './routes/agent-discovery.js';
import { createAuthService } from './services/auth.js';
import { createChainService } from './services/chain.js';
import { CleanverseClient } from './services/cleanverse.js';
import { ComplianceService } from './services/compliance.js';
import { PreflightService } from './services/preflight.js';
import { StoreService } from './services/store.js';
import { EvidenceService } from './services/evidence.js';
import { V2PreflightService } from './services/v2-preflight.js';
import { AgentService } from './services/agent.js';

export async function buildApp(config: ApiConfig) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.x-admin-key', 'req.headers.x-agent-executor-key', 'body.client_secret'] },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RWCAR Institutional Repo and Agent API',
        description: 'V2-only compliant RWA repo execution with bounded, auditable agent intents.',
        version: '1.0.0',
      },
      servers: [{ url: config.AGENT_ISSUER_URL }],
      tags: [
        { name: 'Agent API', description: 'OAuth-authenticated machine interface' },
        { name: 'Agent administration', description: 'Privy-authenticated institution administration' },
      ],
      components: {
        securitySchemes: {
          AgentBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          PrivyBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Privy access token' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((value) => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 8 } });

  const { db, pool } = createDatabase(config.DATABASE_URL);
  const cleanverse = new CleanverseClient(config);
  const chain = createChainService(config);
  const store = new StoreService(db);
  const compliance = new ComplianceService(config, db, cleanverse, chain);
  const preflight = new PreflightService(config, store, compliance, chain);
  const v2Preflight = new V2PreflightService(config, store, compliance, chain);
  const auth = createAuthService(config);
  const evidence = config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
    ? new EvidenceService(config, db)
    : undefined;
  const agent = new AgentService(config, db, store, compliance, chain, v2Preflight, cleanverse);

  registerPublicRoutes(app, config, store);
  registerPreflightRoutes(app, auth, preflight, compliance, store, db);
  registerV2Routes(app, config, auth, v2Preflight, store, chain, db);
  registerInternalRoutes(app, config, db, cleanverse, chain, evidence);
  registerOAuthRoutes(app, config, agent);
  registerAgentDiscoveryRoutes(app, config);
  registerAgentRoutes(app, config, auth, agent);
  registerMcpRoutes(app, config, agent);
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, correlationId, details: error.details });
    }
    const candidate = error as { validation?: unknown };
    if (candidate.validation) {
      return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Request validation failed', correlationId });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', correlationId });
  });
  app.addHook('onClose', async () => { await pool.end(); });
  return app;
}
