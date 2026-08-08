import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { auditLogs, type RwcarDb } from '@rwcar/db';
import { AddressSchema, CreatePreflightSchema, RepoActionPreflightSchema } from '@rwcar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Address } from 'viem';
import type { AuthClaims } from '../services/auth.js';
import type { AuthService } from '../services/auth.js';
import type { ComplianceService } from '../services/compliance.js';
import type { PreflightService } from '../services/preflight.js';
import type { StoreService } from '../services/store.js';
import { AppError } from '../errors.js';

type Authenticate = (request: FastifyRequest) => Promise<AuthClaims>;

export function registerPreflightRoutes(
  app: FastifyInstance,
  auth: AuthService,
  preflight: PreflightService,
  compliance: ComplianceService,
  store: StoreService,
  db: RwcarDb,
) {
  app.post('/v1/preflight/create', { schema: { body: CreatePreflightSchema } }, async (request) => {
    const claims = await auth.authenticate(request);
    const body = request.body as z.infer<typeof CreatePreflightSchema>;
    auth.assertWallet(claims, body.seller);
    const result = await preflight.create(body);
    await recordAudit(db, result.correlationId, body.seller, 'PREFLIGHT_CREATE', body.asset, result);
    return result;
  });
  app.post('/v1/preflight/accept', { schema: { body: RepoActionPreflightSchema } }, async (request) => {
    const claims = await auth.authenticate(request);
    const body = request.body as z.infer<typeof RepoActionPreflightSchema>;
    auth.assertWallet(claims, body.actor);
    const result = await preflight.accept(body.actor as Address, body.repoId);
    await recordAudit(db, result.correlationId, body.actor, 'PREFLIGHT_ACCEPT', body.repoId, result);
    return result;
  });
  app.post('/v1/preflight/repurchase', { schema: { body: RepoActionPreflightSchema } }, async (request) => {
    const claims = await auth.authenticate(request);
    const body = request.body as z.infer<typeof RepoActionPreflightSchema>;
    auth.assertWallet(claims, body.actor);
    const result = await preflight.repurchase(body.actor as Address, body.repoId);
    await recordAudit(db, result.correlationId, body.actor, 'PREFLIGHT_REPURCHASE', body.repoId, result);
    return result;
  });
  app.post('/v1/compliance/verify', {
    schema: { body: z.object({ wallet: AddressSchema, asset: AddressSchema }) },
  }, async (request) => {
    const claims = await auth.authenticate(request);
    const body = request.body as { wallet: `0x${string}`; asset: `0x${string}` };
    auth.assertWallet(claims, body.wallet);
    const asset = await store.getAsset(body.asset);
    if (!asset) throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found');
    const correlationId = randomUUID();
    const result = await compliance.verify(body.wallet, body.asset, asset.cleanverseRequestId, correlationId);
    await db.insert(auditLogs).values({
      correlationId,
      actor: body.wallet.toLowerCase(),
      action: 'COMPLIANCE_VERIFY',
      resourceType: 'asset',
      resourceId: body.asset.toLowerCase(),
      outcome: result.cviActive && result.assetIssued && result.poolEligible === true ? 'ALLOWED' : 'DENIED',
      metadata: { verificationCode: result.verificationCode },
    });
    return { ...result, correlationId };
  });
}

async function recordAudit(
  db: RwcarDb,
  correlationId: string,
  actor: string,
  action: string,
  resourceId: string,
  result: { eligible: boolean; blockingReasons: string[] },
) {
  await db.insert(auditLogs).values({
    correlationId,
    actor: actor.toLowerCase(),
    action,
    resourceType: action === 'PREFLIGHT_CREATE' ? 'asset' : 'repo',
    resourceId: resourceId.toLowerCase(),
    outcome: result.eligible ? 'ALLOWED' : 'DENIED',
    metadata: { blockingReasons: result.blockingReasons },
  });
}
