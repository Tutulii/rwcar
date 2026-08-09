import { timingSafeEqual } from 'node:crypto';
import {
  AddressSchema,
  AgentAuctionActionSchema,
  AgentClaimSchema,
  AgentCreateOfferSchema,
  AgentEligibilityQuerySchema,
  AgentIntentApprovalSchema,
  AgentMarginActionSchema,
  AgentMandateConstraintsSchema,
  AgentOfferActionSchema,
  AgentPositionActionSchema,
  AgentVaultActionSchema,
  BindAgentWalletSchema,
  CreateAgentCredentialSchema,
  CreateAgentMandateSchema,
  CreateAgentSchema,
  ExecuteAgentIntentSchema,
  UintStringSchema,
} from '@rwcar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { AuthClaims, AuthService } from '../services/auth.js';
import type { AgentClaims, AgentService } from '../services/agent.js';

const IdParams = z.object({ agentId: z.string().uuid() });
const IntentParams = IdParams.extend({ intentId: z.string().uuid() });
const CredentialParams = IdParams.extend({ credentialId: z.string().uuid() });

const BindingChallengeSchema = z.object({
  walletAddress: AddressSchema,
  privyWalletId: z.string().trim().min(3).max(200),
  signerId: z.string().trim().min(3).max(200),
  policyId: z.string().trim().min(3).max(200),
});

const ApprovalChallengeSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']) });
const AgentStatusSchema = z.object({ status: z.enum(['PAUSED', 'REVOKED', 'ACTIVE']) });
const OfferQuoteQuery = z.object({ offerId: UintStringSchema, principalAmount: UintStringSchema });
const AuctionQuery = z.object({ includeClosed: z.enum(['true', 'false']).optional().transform((value) => value === 'true') });
const ExecutorLeaseSchema = z.object({ workerId: z.string().trim().min(3).max(100) });
const ExecutorParams = z.object({ intentId: z.string().uuid() });
const ExecutorRefreshSchema = ExecutorLeaseSchema;
const ExecutorStepParams = ExecutorParams.extend({ stepIndex: z.coerce.number().int().nonnegative() });
const ExecutorStepSchema = ExecutorLeaseSchema.extend({
  status: z.enum(['SIGNING', 'SUBMITTED', 'CONFIRMED', 'FAILED']),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  privyActionId: z.string().min(1).max(200).optional(),
  errorMessage: z.string().max(1_000).optional(),
}).superRefine((value, context) => {
  if ((value.status === 'SUBMITTED' || value.status === 'CONFIRMED') && !value.txHash) {
    context.addIssue({ code: 'custom', path: ['txHash'], message: 'A transaction hash is required for submitted or confirmed steps' });
  }
  if (value.status === 'FAILED' && !value.errorMessage) {
    context.addIssue({ code: 'custom', path: ['errorMessage'], message: 'A bounded error message is required for failed steps' });
  }
  if (value.status === 'SIGNING' && value.txHash) {
    context.addIssue({ code: 'custom', path: ['txHash'], message: 'A signing marker cannot claim a transaction hash' });
  }
});

export function registerAgentRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  auth: AuthService,
  service: AgentService,
) {
  const human = (request: FastifyRequest): Promise<AuthClaims> => auth.authenticate(request);
  const machine = (request: FastifyRequest): Promise<AgentClaims> => service.authenticateBearer(request.headers.authorization);

  app.get('/v2/agents', { schema: { tags: ['Agent administration'] } }, async (request) => service.listAgents(await human(request)));

  app.post('/v2/agents', {
    schema: { tags: ['Agent administration'], body: CreateAgentSchema },
  }, async (request) => {
    const body = request.body as z.infer<typeof CreateAgentSchema>;
    return service.createAgent(await human(request), { ...body, adminWallet: body.adminWallet as Address });
  });

  app.get('/v2/agents/:agentId', {
    schema: { tags: ['Agent administration'], params: IdParams },
  }, async (request) => service.getAdminAgent(await human(request), (request.params as z.infer<typeof IdParams>).agentId));

  app.post('/v2/agents/:agentId/wallet/challenge', {
    schema: { tags: ['Agent administration'], params: IdParams, body: BindingChallengeSchema },
  }, async (request) => service.walletBindingChallenge(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    { ...(request.body as z.infer<typeof BindingChallengeSchema>), walletAddress: (request.body as z.infer<typeof BindingChallengeSchema>).walletAddress as Address },
  ));

  app.post('/v2/agents/:agentId/wallet', {
    schema: { tags: ['Agent administration'], params: IdParams, body: BindAgentWalletSchema },
  }, async (request) => service.bindWallet(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    request.body as unknown as Parameters<AgentService['bindWallet']>[2],
  ));

  app.post('/v2/agents/:agentId/mandates/challenge', {
    schema: { tags: ['Agent administration'], params: IdParams, body: CreateAgentMandateSchema.omit({ signature: true }) },
  }, async (request) => service.mandateChallenge(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    request.body as {
      wallet: Address;
      manifestHash: Hex;
      constraints: z.infer<typeof AgentMandateConstraintsSchema>;
    },
  ));

  app.post('/v2/agents/:agentId/mandates', {
    schema: { tags: ['Agent administration'], params: IdParams, body: CreateAgentMandateSchema },
  }, async (request) => service.createMandate(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    request.body as z.infer<typeof CreateAgentMandateSchema> as z.infer<typeof CreateAgentMandateSchema> & { wallet: Address; manifestHash: Hex; signature: Hex },
  ));

  app.post('/v2/agents/:agentId/compliance/refresh', {
    schema: { tags: ['Agent administration'], params: IdParams },
  }, async (request) => service.refreshCompliance(await human(request), (request.params as z.infer<typeof IdParams>).agentId));

  app.post('/v2/agents/:agentId/cvi/enroll-uat', {
    schema: { tags: ['Agent administration'], params: IdParams },
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
  }, async (request) => service.enrollUatCvi(await human(request), (request.params as z.infer<typeof IdParams>).agentId));

  app.post('/v2/agents/:agentId/credentials', {
    schema: { tags: ['Agent administration'], params: IdParams, body: CreateAgentCredentialSchema },
  }, async (request) => service.createCredential(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    request.body as z.infer<typeof CreateAgentCredentialSchema>,
  ));

  app.delete('/v2/agents/:agentId/credentials/:credentialId', {
    schema: { tags: ['Agent administration'], params: CredentialParams },
  }, async (request) => {
    const params = request.params as z.infer<typeof CredentialParams>;
    return service.revokeCredential(await human(request), params.agentId, params.credentialId);
  });

  app.post('/v2/agents/:agentId/status', {
    schema: { tags: ['Agent administration'], params: IdParams, body: AgentStatusSchema },
  }, async (request) => service.setAgentStatus(
    await human(request),
    (request.params as z.infer<typeof IdParams>).agentId,
    (request.body as z.infer<typeof AgentStatusSchema>).status,
  ));

  app.get('/v2/agents/:agentId/intents', {
    schema: { tags: ['Agent administration'], params: IdParams },
  }, async (request) => service.listAdminIntents(await human(request), (request.params as z.infer<typeof IdParams>).agentId));

  app.post('/v2/agents/:agentId/intents/:intentId/approval/challenge', {
    schema: { tags: ['Agent administration'], params: IntentParams, body: ApprovalChallengeSchema },
  }, async (request) => {
    const params = request.params as z.infer<typeof IntentParams>;
    return service.approvalChallenge(await human(request), params.agentId, params.intentId, (request.body as z.infer<typeof ApprovalChallengeSchema>).decision);
  });

  app.post('/v2/agents/:agentId/intents/:intentId/approval', {
    schema: { tags: ['Agent administration'], params: IntentParams, body: AgentIntentApprovalSchema },
  }, async (request) => {
    const params = request.params as z.infer<typeof IntentParams>;
    return service.approveIntent(
      await human(request),
      params.agentId,
      params.intentId,
      request.body as z.infer<typeof AgentIntentApprovalSchema> as z.infer<typeof AgentIntentApprovalSchema> & { signature: Hex },
    );
  });

  // Machine REST surface. MCP calls the same methods, so REST and MCP cannot
  // drift into different policy or preflight behavior.
  app.get('/agent/v1/protocol', { schema: { tags: ['Agent API'] } }, async (request) => service.protocolInfo(await machine(request)));
  app.get('/agent/v1/eligibility', {
    schema: { tags: ['Agent API'], querystring: AgentEligibilityQuerySchema },
  }, async (request) => service.eligibility(await machine(request), (request.query as z.infer<typeof AgentEligibilityQuerySchema>).asset as Address));
  app.get('/agent/v1/assets', { schema: { tags: ['Agent API'] } }, async (request) => service.listVerifiedAssets(await machine(request)));
  app.get('/agent/v1/offers', { schema: { tags: ['Agent API'] } }, async (request) => service.listOffers(await machine(request)));
  app.get('/agent/v1/offers/quote', {
    schema: { tags: ['Agent API'], querystring: OfferQuoteQuery },
  }, async (request) => {
    const query = request.query as z.infer<typeof OfferQuoteQuery>;
    return service.offerQuote(await machine(request), query.offerId, query.principalAmount);
  });
  app.get('/agent/v1/portfolio', { schema: { tags: ['Agent API'] } }, async (request) => service.portfolio(await machine(request)));
  app.get('/agent/v1/margin-accounts', { schema: { tags: ['Agent API'] } }, async (request) => service.marginAccounts(await machine(request)));
  app.get('/agent/v1/auctions', {
    schema: { tags: ['Agent API'], querystring: AuctionQuery },
  }, async (request) => service.auctions(await machine(request), (request.query as z.infer<typeof AuctionQuery>).includeClosed));
  app.get('/agent/v1/intents/:intentId', {
    schema: { tags: ['Agent API'], params: z.object({ intentId: z.string().uuid() }) },
  }, async (request) => service.intentStatus(await machine(request), (request.params as { intentId: string }).intentId));

  app.post('/agent/v1/intents/vault', {
    schema: { tags: ['Agent API'], body: AgentVaultActionSchema },
  }, async (request) => service.prepareVault(await machine(request), request.body as z.infer<typeof AgentVaultActionSchema> as Parameters<AgentService['prepareVault']>[1]));
  app.post('/agent/v1/intents/offers/create', {
    schema: { tags: ['Agent API'], body: AgentCreateOfferSchema },
  }, async (request) => service.prepareCreateOffer(await machine(request), request.body as z.infer<typeof AgentCreateOfferSchema>));
  app.post('/agent/v1/intents/offers/action', {
    schema: { tags: ['Agent API'], body: AgentOfferActionSchema },
  }, async (request) => service.prepareOfferAction(await machine(request), request.body as z.infer<typeof AgentOfferActionSchema> as Parameters<AgentService['prepareOfferAction']>[1]));
  app.post('/agent/v1/intents/positions/action', {
    schema: { tags: ['Agent API'], body: AgentPositionActionSchema },
  }, async (request) => service.preparePositionAction(await machine(request), request.body as z.infer<typeof AgentPositionActionSchema> as Parameters<AgentService['preparePositionAction']>[1]));
  app.post('/agent/v1/intents/auctions/action', {
    schema: { tags: ['Agent API'], body: AgentAuctionActionSchema },
  }, async (request) => service.prepareAuctionAction(await machine(request), request.body as z.infer<typeof AgentAuctionActionSchema> as Parameters<AgentService['prepareAuctionAction']>[1]));
  app.post('/agent/v1/intents/claims', {
    schema: { tags: ['Agent API'], body: AgentClaimSchema },
  }, async (request) => service.prepareClaim(await machine(request), request.body as z.infer<typeof AgentClaimSchema> as Parameters<AgentService['prepareClaim']>[1]));
  app.post('/agent/v1/intents/margin', {
    schema: { tags: ['Agent API'], body: AgentMarginActionSchema },
  }, async (request) => service.prepareMargin(await machine(request), request.body as z.infer<typeof AgentMarginActionSchema>));
  app.post('/agent/v1/intents/:intentId/execute', {
    schema: { tags: ['Agent API'], params: z.object({ intentId: z.string().uuid() }), body: ExecuteAgentIntentSchema },
  }, async (request) => {
    const params = request.params as { intentId: string };
    const body = request.body as z.infer<typeof ExecuteAgentIntentSchema>;
    if (params.intentId !== body.intentId) throw new AppError(409, 'INTENT_ID_MISMATCH', 'Path and body intent identifiers must match');
    return service.executeIntent(await machine(request), params.intentId, body.expectedIntentHash as Hex);
  });

  const executor = (request: FastifyRequest) => {
    const configured = config.AGENT_EXECUTOR_API_KEY;
    const supplied = request.headers['x-agent-executor-key'];
    if (!configured || typeof supplied !== 'string') throw new AppError(401, 'EXECUTOR_AUTH_REQUIRED', 'Executor authentication is required');
    const left = Buffer.from(configured);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new AppError(401, 'INVALID_EXECUTOR_AUTH', 'Executor authentication failed');
  };

  app.post('/internal/agent-executor/lease', {
    schema: { hide: true, body: ExecutorLeaseSchema },
  }, async (request) => {
    executor(request);
    return service.leaseIntent((request.body as z.infer<typeof ExecutorLeaseSchema>).workerId);
  });
  app.post('/internal/agent-executor/intents/:intentId/refresh', {
    schema: { hide: true, params: ExecutorParams, body: ExecutorRefreshSchema },
  }, async (request) => {
    executor(request);
    return service.refreshIntent((request.params as z.infer<typeof ExecutorParams>).intentId, (request.body as z.infer<typeof ExecutorRefreshSchema>).workerId);
  });
  app.post('/internal/agent-executor/intents/:intentId/steps/:stepIndex', {
    schema: { hide: true, params: ExecutorStepParams, body: ExecutorStepSchema },
  }, async (request) => {
    executor(request);
    const params = request.params as z.infer<typeof ExecutorStepParams>;
    const body = request.body as z.infer<typeof ExecutorStepSchema>;
    return service.reportStep(body.workerId, params.intentId, params.stepIndex, body);
  });
  app.post('/internal/agent-executor/intents/:intentId/complete', {
    schema: { hide: true, params: ExecutorParams, body: ExecutorLeaseSchema },
  }, async (request) => {
    executor(request);
    return service.completeIntent((request.body as z.infer<typeof ExecutorLeaseSchema>).workerId, (request.params as z.infer<typeof ExecutorParams>).intentId);
  });
}
