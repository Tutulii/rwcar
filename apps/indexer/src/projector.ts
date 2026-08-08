import { eq, sql } from 'drizzle-orm';
import { chainEvents, repos, type RwcarDb } from '@rwcar/db';

type RwcarTransaction = Parameters<Parameters<RwcarDb['transaction']>[0]>[0];

export type ProjectableEvent = {
  eventName: string;
  args: Record<string, unknown>;
  chainId: number;
  marketAddress: string;
  transactionHash: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
};

const address = (value: unknown) => String(value).toLowerCase();
const numberString = (value: unknown) => BigInt(value as bigint | string | number).toString();
const date = (seconds: unknown) => new Date(Number(BigInt(seconds as bigint | string | number)) * 1000);

export async function projectEvent(db: RwcarTransaction, event: ProjectableEvent) {
  const args = event.args;
  const whereRepo = sql`${repos.chainId} = ${event.chainId} AND ${repos.marketAddress} = ${event.marketAddress} AND ${repos.repoId} = ${numberString(args.repoId)}`;
  const common = { lastTxHash: event.transactionHash, lastBlockNumber: event.blockNumber, updatedAt: new Date() };

  switch (event.eventName) {
    case 'OfferCreated':
      await db.insert(repos).values({
        chainId: event.chainId,
        marketAddress: event.marketAddress,
        repoId: numberString(args.repoId),
        seller: address(args.seller),
        buyer: null,
        permittedBuyer: address(args.permittedBuyer) === '0x0000000000000000000000000000000000000000' ? null : address(args.permittedBuyer),
        assetAddress: address(args.asset),
        collateralAmount: numberString(args.collateralAmount),
        principalAmount: numberString(args.principalAmount),
        annualRateBps: Number(args.annualRateBps),
        durationSeconds: Number(args.duration),
        offerExpiry: date(args.offerExpiry),
        valuationHash: String(args.valuationHash),
        status: 'OPEN',
        createTxHash: event.transactionHash,
        ...common,
      }).onConflictDoNothing();
      break;
    case 'ProtocolFeePaid':
      await db.update(repos).set({ openingFee: numberString(args.amount), ...common }).where(whereRepo);
      break;
    case 'OfferAccepted':
      await db.update(repos).set({
        buyer: address(args.buyer),
        repurchaseAmount: numberString(args.repurchaseAmount),
        openedAt: new Date(Number(event.blockTimestamp) * 1000),
        maturityAt: date(args.maturity),
        graceEndsAt: date(args.repaymentDeadline),
        status: 'ACTIVE',
        ...common,
      }).where(whereRepo);
      break;
    case 'OfferCancelled':
      await db.update(repos).set({ status: 'CANCELLED', closedAt: new Date(Number(event.blockTimestamp) * 1000), ...common }).where(whereRepo);
      break;
    case 'OfferExpired':
      await db.update(repos).set({ status: 'EXPIRED', closedAt: new Date(Number(event.blockTimestamp) * 1000), ...common }).where(whereRepo);
      break;
    case 'RepoRepaid':
      await db.update(repos).set({ status: 'REPAID', closedAt: new Date(Number(event.blockTimestamp) * 1000), ...common }).where(whereRepo);
      break;
    case 'RepoDefaulted':
      await db.update(repos).set({ status: 'DEFAULTED', closedAt: new Date(Number(event.blockTimestamp) * 1000), ...common }).where(whereRepo);
      break;
  }
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
  }
  return value;
}
