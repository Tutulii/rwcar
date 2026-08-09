import {
  AgentAuctionActionSchema,
  AgentClaimSchema,
  AgentCreateOfferSchema,
  AgentEligibilityQuerySchema,
  AgentMarginActionSchema,
  AgentOfferActionSchema,
  AgentPositionActionSchema,
  AgentVaultActionSchema,
  ExecuteAgentIntentSchema,
  UintStringSchema,
} from '@rwcar/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { AgentClaims, AgentService } from '../services/agent.js';

export const RWCAR_MCP_TOOLS = [
  'get_protocol_info',
  'check_eligibility',
  'list_verified_assets',
  'list_offers',
  'get_offer_quote',
  'get_portfolio',
  'get_margin_accounts',
  'list_auctions',
  'get_execution_status',
  'prepare_vault_action',
  'prepare_create_offer',
  'prepare_offer_action',
  'prepare_position_action',
  'prepare_auction_action',
  'prepare_claim',
  'prepare_margin_action',
  'execute_intent',
] as const;

export const RWCAR_MCP_TOOL_SCOPES: Record<(typeof RWCAR_MCP_TOOLS)[number], string> = {
  get_protocol_info: 'protocol:read',
  check_eligibility: 'protocol:read',
  list_verified_assets: 'protocol:read',
  list_offers: 'protocol:read',
  get_offer_quote: 'protocol:read',
  get_portfolio: 'protocol:read',
  get_margin_accounts: 'protocol:read',
  list_auctions: 'protocol:read',
  get_execution_status: 'protocol:read',
  prepare_vault_action: 'vault:write',
  prepare_create_offer: 'offers:write',
  prepare_offer_action: 'offers:write',
  prepare_position_action: 'positions:write',
  prepare_auction_action: 'auctions:write',
  prepare_claim: 'claims:write',
  prepare_margin_action: 'margin:write',
  execute_intent: 'intents:execute',
};

const Empty = z.object({});
const OfferQuote = z.object({ offerId: UintStringSchema, principalAmount: UintStringSchema });
const ExecutionStatus = z.object({ intentId: z.string().uuid() });
const ListAuctions = z.object({ includeClosed: z.boolean().default(false) });

function toolResult(value: unknown) {
  const structuredContent = { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function safeTool<TInput>(handler: (input: TInput) => Promise<unknown>) {
  return async (input: TInput) => {
    try {
      return toolResult(await handler(input));
    } catch (error) {
      const safe = error instanceof AppError
        ? { code: error.code, message: error.message, details: error.details }
        : { code: 'INTERNAL_ERROR', message: 'The RWCAR tool call failed unexpectedly' };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
        structuredContent: { error: safe },
        isError: true,
      };
    }
  };
}

export function createRwcarMcpServer(service: AgentService, claims: AgentClaims) {
  const server = new McpServer({ name: 'rwcar-agent', version: '1.0.0' });

  server.registerTool('get_protocol_info', {
    title: 'Get RWCAR protocol information',
    description: 'Read Monad chain, verified contracts, settlement asset, deployment health, and agent safety posture.',
    inputSchema: Empty,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async () => service.protocolInfo(claims)));

  server.registerTool('check_eligibility', {
    title: 'Check Cleanverse eligibility',
    description: 'Run live CVI/A-Pass, CVA issuance/pause, and on-chain policy-pool eligibility for this agent wallet and one asset.',
    inputSchema: AgentEligibilityQuerySchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async (input) => service.eligibility(claims, input.asset as Address)));

  server.registerTool('list_verified_assets', {
    title: 'List verified RWA assets',
    description: 'List only enabled, Cleanverse-issued CVAs accepted by the RWCAR V2 market.',
    inputSchema: Empty,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async () => service.listVerifiedAssets(claims)));

  server.registerTool('list_offers', {
    title: 'List open repo offers',
    description: 'List finalized-indexer V2 offers that remain open at the current Monad block time.',
    inputSchema: Empty,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async () => service.listOffers(claims)));

  server.registerTool('get_offer_quote', {
    title: 'Quote a partial repo fill',
    description: 'Calculate deterministic pro-rata collateral, fee, seller proceeds, and remaining offer amounts without creating an intent.',
    inputSchema: OfferQuote,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async (input) => service.offerQuote(claims, input.offerId, input.principalAmount)));

  server.registerTool('get_portfolio', {
    title: 'Get agent portfolio',
    description: 'Read offers, positions, tri-party vault buckets, settlement claims, and recent finalized activity for the bound agent wallet.',
    inputSchema: Empty,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async () => service.portfolio(claims)));

  server.registerTool('get_margin_accounts', {
    title: 'Get shared-collateral margin accounts',
    description: 'Read netting sets, exposures, margin calls, and lender relationships involving the bound agent wallet.',
    inputSchema: Empty,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async () => service.marginAccounts(claims)));

  server.registerTool('list_auctions', {
    title: 'List Dutch auctions',
    description: 'List live or historical RWCAR liquidation auctions. Live purchase price is re-checked during prepare and execution.',
    inputSchema: ListAuctions,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async (input) => service.auctions(claims, input.includeClosed)));

  server.registerTool('get_execution_status', {
    title: 'Get durable intent status',
    description: 'Read policy decision, human-approval state, each transaction step, Monad hashes, indexing state, and terminal errors.',
    inputSchema: ExecutionStatus,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, safeTool(async (input) => service.intentStatus(claims, input.intentId)));

  server.registerTool('prepare_vault_action', {
    title: 'Prepare a tri-party vault action',
    description: 'Create a bounded deposit or withdrawal intent after live Cleanverse, balance, allowance, vault, and policy checks. This does not sign.',
    inputSchema: AgentVaultActionSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareVault(claims, input as Parameters<AgentService['prepareVault']>[1])));

  server.registerTool('prepare_create_offer', {
    title: 'Prepare a repo offer',
    description: 'Create a durable V2 offer intent with valuation, LTV, CVI/CVA, vault, duration, rate, and mandate enforcement. This does not sign.',
    inputSchema: AgentCreateOfferSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareCreateOffer(claims, input)));

  server.registerTool('prepare_offer_action', {
    title: 'Prepare an offer action',
    description: 'Create a fill, cancel, or expiry-finalization intent. Partial fills use exact pro-rata accounting and live compliance checks.',
    inputSchema: AgentOfferActionSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareOfferAction(claims, input as Parameters<AgentService['prepareOfferAction']>[1])));

  server.registerTool('prepare_position_action', {
    title: 'Prepare a repo position action',
    description: 'Create a repay, auction-start, failed-auction collateral claim, or stale-oracle fallback intent with lifecycle gates.',
    inputSchema: AgentPositionActionSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.preparePositionAction(claims, input as Parameters<AgentService['preparePositionAction']>[1])));

  server.registerTool('prepare_auction_action', {
    title: 'Prepare an auction action',
    description: 'Create a first-successful-fill Dutch auction purchase or failed-auction finalization intent. Purchases always need human approval.',
    inputSchema: AgentAuctionActionSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareAuctionAction(claims, input as Parameters<AgentService['prepareAuctionAction']>[1])));

  server.registerTool('prepare_claim', {
    title: 'Prepare a settlement escrow claim',
    description: 'Create a bounded claim intent against an on-chain-proven RWCAR escrow and verified beneficiary.',
    inputSchema: AgentClaimSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareClaim(claims, input as Parameters<AgentService['prepareClaim']>[1])));

  server.registerTool('prepare_margin_action', {
    title: 'Prepare a cross-margin action',
    description: 'Create a shared-collateral margin intent with netting-set, oracle, LTV, exposure, compliance, and mandate checks. Margin actions need human approval.',
    inputSchema: AgentMarginActionSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, safeTool(async (input) => service.prepareMargin(claims, input)));

  server.registerTool('execute_intent', {
    title: 'Queue an approved RWCAR intent',
    description: 'Queue a previously prepared intent only when its exact hash matches and all mandate/human-approval gates pass. The isolated executor re-preflights before signing.',
    inputSchema: ExecuteAgentIntentSchema,
    annotations: { destructiveHint: true, idempotentHint: true },
  }, safeTool(async (input) => service.executeIntent(claims, input.intentId, input.expectedIntentHash as Hex)));

  return server;
}

function allowedHostname(value: string | undefined, allowed: Set<string>) {
  if (!value) return true;
  try {
    const host = value.includes('://') ? new URL(value).hostname : new URL(`http://${value}`).hostname;
    return allowed.has(host.toLowerCase());
  } catch {
    return false;
  }
}

function requestedTool(body: unknown): (typeof RWCAR_MCP_TOOLS)[number] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== 'tools/call' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return undefined;
  const name = (message.params as { name?: unknown }).name;
  return typeof name === 'string' && RWCAR_MCP_TOOLS.includes(name as (typeof RWCAR_MCP_TOOLS)[number])
    ? name as (typeof RWCAR_MCP_TOOLS)[number]
    : undefined;
}

export function registerMcpRoutes(app: FastifyInstance, config: ApiConfig, service: AgentService) {
  const handler = createMcpHandler((context) => {
    const claims = context.authInfo?.extra?.agentClaims as AgentClaims | undefined;
    if (!claims) throw new AppError(401, 'AGENT_AUTH_REQUIRED', 'MCP authentication context is missing');
    return createRwcarMcpServer(service, claims);
  }, {
    legacy: 'stateless',
    responseMode: 'auto',
    onerror: (error) => app.log.error({ err: error }, 'MCP handler error'),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => app.log.error({ err: error }, 'MCP Node adapter error'),
  });
  const allowed = new Set(config.AGENT_MCP_ALLOWED_HOSTS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  allowed.add(new URL(config.AGENT_ISSUER_URL).hostname.toLowerCase());

  app.all('/mcp', { schema: { hide: true } }, async (request, reply) => {
    if (!allowedHostname(request.headers.host, allowed) || !allowedHostname(request.headers.origin, allowed)) {
      throw new AppError(403, 'MCP_ORIGIN_REJECTED', 'MCP Host or Origin is not allowed');
    }
    let claims: AgentClaims;
    const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.AGENT_ISSUER_URL).toString();
    try {
      claims = await service.authenticateBearer(request.headers.authorization);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        const invalid = error.code === 'AGENT_AUTH_REQUIRED' ? '' : ', error="invalid_token"';
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="protocol:read"${invalid}`);
      }
      throw error;
    }
    const tool = requestedTool(request.body);
    const requiredScope = tool ? RWCAR_MCP_TOOL_SCOPES[tool] : undefined;
    if (requiredScope && !claims.scopes.includes(requiredScope as AgentClaims['scopes'][number])) {
      reply.header(
        'WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${metadataUrl}"`,
      );
      throw new AppError(403, 'INSUFFICIENT_SCOPE', `The ${requiredScope} scope is required`);
    }
    const authorization = request.headers.authorization!;
    const authInfo: AuthInfo = {
      token: authorization.slice(7),
      clientId: claims.credentialId,
      scopes: claims.scopes,
      ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
      resource: new URL(config.AGENT_AUDIENCE, config.AGENT_ISSUER_URL),
      extra: { agentClaims: claims },
    };
    (request.raw as typeof request.raw & { auth?: AuthInfo }).auth = authInfo;
    reply.hijack();
    await nodeHandler(request.raw as unknown as Parameters<typeof nodeHandler>[0], reply.raw, request.body);
  });

  app.addHook('onClose', async () => handler.close());
}
