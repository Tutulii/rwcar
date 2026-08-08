import { and, eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { assets } from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

// This is the exact Cleanverse-issued collateral in the reviewed Monad UAT
// release. The bootstrap inserts it only into a fresh database; it never
// re-enables or unpauses a record that an operator deliberately disabled.
export const monadUatAsset = {
  chainId: 10_143,
  address: '0x7a33e03b10268ffdb50e562721b092bc0cb793f9',
  name: 'RWCAR Receivable Note I',
  symbol: 'RWRN01',
  decimals: 6,
  cleanverseRequestId: 'IA20260805120745190158',
  cleanverseStatus: 'ISSUED',
  paused: false,
  enabled: true,
  evidenceHash: '0xb5231edafb76c0b32468759cbf2738977bf8504476fde4638a516686c95b5afe',
  valuationHash: '0xa075a91ee2b6428706d4d2064e5ad4ca6047348f73097669d3dffa325671c5a0',
  metadata: {
    cleanverse: {
      chain: 'monad',
      txHash: '0xeb0adb893e98171fef8f67d118e8da3b0816dad03f7a1d016116273dbf13c785',
      flowType: 'LAUNCH',
      issuedAt: '2026-08-05 12:07:45',
      requestId: 'IA20260805120745190158',
      applyStatus: 'ISSUED',
      tokenSymbol: 'RWRN01',
      atokenAddress: '0x7A33e03B10268FFdB50e562721B092BC0Cb793F9',
      issueErrorMsg: '',
    },
  },
} as const;

const { db, pool } = createDatabase(databaseUrl);
try {
  await db.insert(assets).values(monadUatAsset).onConflictDoNothing({
    target: [assets.chainId, assets.address],
  });
  const [record] = await db.select().from(assets).where(and(
    eq(assets.chainId, monadUatAsset.chainId),
    eq(assets.address, monadUatAsset.address),
  )).limit(1);
  if (!record) throw new Error('Monad UAT asset bootstrap did not persist RWRN01');

  const expected = {
    name: monadUatAsset.name,
    symbol: monadUatAsset.symbol,
    decimals: monadUatAsset.decimals,
    cleanverseRequestId: monadUatAsset.cleanverseRequestId,
    cleanverseStatus: monadUatAsset.cleanverseStatus,
    evidenceHash: monadUatAsset.evidenceHash,
    valuationHash: monadUatAsset.valuationHash,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (record[field as keyof typeof record] !== value) {
      throw new Error(`Existing RWRN01 release record has unexpected ${field}`);
    }
  }
  console.log(`Monad UAT asset ${record.symbol} is present; operational enabled/paused state was preserved.`);
} finally {
  await pool.end();
}
