import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transactionSourceCoverage } from '../src/services/store.js';

describe('V2 transaction indexing coverage', () => {
  it('does not finalize a transaction until every enabled source has crossed its block', () => {
    const deployments = [
      { chainId: 10_143, module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001' },
      { chainId: 10_143, module: 'DUTCH_AUCTION', address: '0x0000000000000000000000000000000000000002' },
      { chainId: 10_143, module: 'SETTLEMENT_ESCROW', address: '0x0000000000000000000000000000000000000003' },
    ];
    const partial = transactionSourceCoverage(100n, deployments, [
      { chainId: 10_143, consumer: 'v2:repo_market:0x0000000000000000000000000000000000000001', blockNumber: 100n },
      { chainId: 10_143, consumer: 'v2:dutch_auction:0x0000000000000000000000000000000000000002', blockNumber: 99n },
    ]);
    assert.equal(partial.every((source) => source.completeThroughTransaction), false);
    const complete = transactionSourceCoverage(100n, deployments, [
      { chainId: 10_143, consumer: 'v2:repo_market:0x0000000000000000000000000000000000000001', blockNumber: 101n },
      { chainId: 10_143, consumer: 'v2:dutch_auction:0x0000000000000000000000000000000000000002', blockNumber: 100n },
      { chainId: 10_143, consumer: 'v2:settlement_escrow:0x0000000000000000000000000000000000000003', blockNumber: 100n },
    ]);
    assert.equal(complete.every((source) => source.completeThroughTransaction), true);
  });
});
