import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { createDatabase } from '@rwcar/db';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ApiConfig } from './config.js';
import { AppError } from './errors.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerV2Routes } from './routes/v2.js';
import { createAuthService } from './services/auth.js';
import { createChainService } from './services/chain.js';
import { CleanverseClient } from './services/cleanverse.js';
import { ComplianceService } from './services/compliance.js';
import { PreflightService } from './services/preflight.js';
import { StoreService } from './services/store.js';
import { EvidenceService } from './services/evidence.js';
import { V2PreflightService } from './services/v2-preflight.js';

export async function buildApp(config: ApiConfig) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.x-admin-key'] },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((value) => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
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

  registerPublicRoutes(app, config, store);
  registerPreflightRoutes(app, auth, preflight, compliance, store, db);
  registerV2Routes(app, config, auth, v2Preflight, store, chain, db);
  registerInternalRoutes(app, config, db, cleanverse, chain, evidence);

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
