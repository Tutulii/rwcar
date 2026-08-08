import { z } from 'zod';
import { AddressSchema, MONAD_TESTNET, PROTOCOL_FEE_BPS, UAT_TERMS } from '@rwcar/shared';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import type { StoreService } from '../services/store.js';
import { serializeRow } from '../services/store.js';

export const ActivityQuerySchema = z.object({
  wallet: AddressSchema.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(4),
});

export function registerPublicRoutes(app: FastifyInstance, config: ApiConfig, store: StoreService) {
  app.get('/health', async () => ({ status: 'ok', service: 'rwcar-api', timestamp: new Date().toISOString() }));
  app.get('/v1/config', async () => ({
    chain: MONAD_TESTNET,
    contracts: {
      repoMarket: config.REPO_MARKET_ADDRESS ?? null,
      assetRegistry: config.ASSET_REGISTRY_ADDRESS ?? null,
    },
    terms: UAT_TERMS,
    protocolFeeBps: PROTOCOL_FEE_BPS,
  }));
  app.get('/v1/assets', async () => serializeRow(await store.listAssets()));
  app.get('/v1/offers', async () => serializeRow(await store.listOpenRepos()));
  app.get('/v1/activity', {
    schema: { querystring: ActivityQuerySchema },
  }, async (request) => {
    const { wallet, limit } = request.query as { wallet?: `0x${string}`; limit: number };
    return serializeRow(await store.listActivity(wallet, limit));
  });
  app.get('/v1/positions/:wallet', {
    schema: { params: z.object({ wallet: AddressSchema }) },
  }, async (request) => {
    const { wallet } = request.params as { wallet: `0x${string}` };
    return serializeRow(await store.listPositions(wallet));
  });
}
