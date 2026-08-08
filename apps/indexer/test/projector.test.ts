import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoMarketV2Abi } from '@rwcar/shared';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, keccak256 } from 'viem';
import { loadConfig, parseV2DeploymentSources } from '../src/config.js';
import { keeperCheckpointState, keeperRetryKey } from '../src/keeper.js';
import { jsonSafe } from '../src/projector.js';
import {
  automationRetryDelayMs,
  isAutomationLeaseClaimable,
  isSignedAutomationTransaction,
  isSupportedV2JobAction,
} from '../src/v2-keeper.js';
import { canonicalCheckpointMatches, v2Consumer } from '../src/v2-indexer.js';
import { offerFilledPositionSnapshot } from '../src/v2-projector.js';

const requiredConfig = {
  DATABASE_URL: 'postgresql://rwcar:rwcar@127.0.0.1:5432/rwcar',
  REPO_MARKET_ADDRESS: '0x90535a7176a3b2c251c834b28e11e245622ee808',
  REPO_MARKET_DEPLOYMENT_BLOCK: '51054911',
};

describe('indexer serialization', () => {
  it('preserves uint256 values without JSON precision loss', () => {
    assert.deepEqual(jsonSafe({ repoId: 2n ** 200n, nested: [1n] }), {
      repoId: (2n ** 200n).toString(),
      nested: ['1'],
    });
  });

  it('defaults log scans to Monad-compatible 100-block batches', () => {
    assert.equal(loadConfig(requiredConfig).INDEXER_BATCH_SIZE, 100n);
  });

  it('rejects log scan batches above the Monad RPC limit', () => {
    assert.throws(() => loadConfig({ ...requiredConfig, INDEXER_BATCH_SIZE: '101' }));
  });

  it('keeps default automation optional and validates configured signing keys', () => {
    assert.equal(loadConfig(requiredConfig).KEEPER_PRIVATE_KEY, undefined);
    assert.throws(() => loadConfig({ ...requiredConfig, KEEPER_PRIVATE_KEY: 'not-a-private-key' }));
    assert.equal(
      loadConfig({ ...requiredConfig, KEEPER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }).KEEPER_POLL_MS,
      10_000,
    );
  });

  it('namespaces expiry and default retry cooldowns independently', () => {
    assert.equal(keeperRetryKey('expireOffer', '7'), 'expireOffer:7');
    assert.equal(keeperRetryKey('markDefault', '7'), 'markDefault:7');
    assert.notEqual(keeperRetryKey('expireOffer', '7'), keeperRetryKey('markDefault', '7'));
  });

  it('requires a checkpoint at the finalized head before keeper actions', () => {
    assert.deepEqual(keeperCheckpointState(undefined, 100n, 3n), {
      caughtUp: false,
      checkpointBlock: undefined,
      finalizedBlock: 97n,
    });
    assert.deepEqual(keeperCheckpointState(96n, 100n, 3n), {
      caughtUp: false,
      checkpointBlock: 96n,
      finalizedBlock: 97n,
    });
    assert.deepEqual(keeperCheckpointState(97n, 100n, 3n), {
      caughtUp: true,
      checkpointBlock: 97n,
      finalizedBlock: 97n,
    });
    assert.equal(keeperCheckpointState(99n, 100n, 3n).caughtUp, true);
  });

  it('parses and namespaces independent V2 deployment sources', () => {
    const config = loadConfig({
      ...requiredConfig,
      V2_DEPLOYMENTS_JSON: JSON.stringify([
        { module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001', deploymentBlock: '100' },
        { module: 'COLLATERAL_VAULT', address: '0x0000000000000000000000000000000000000002', deploymentBlock: '101', metadata: { controllerAddress: '0x0000000000000000000000000000000000000001' } },
      ]),
    });
    const sources = parseV2DeploymentSources(config);
    assert.equal(sources.length, 2);
    assert.equal(sources[1]?.metadata.controllerAddress, '0x0000000000000000000000000000000000000001');
    assert.notEqual(v2Consumer(sources[0]!), v2Consumer(sources[1]!));
    const reordered = parseV2DeploymentSources(loadConfig({
      ...requiredConfig,
      V2_DEPLOYMENTS_JSON: JSON.stringify([
        { module: 'DUTCH_AUCTION', address: '0x0000000000000000000000000000000000000002', deploymentBlock: 100, metadata: { controllerAddress: '0x0000000000000000000000000000000000000001' } },
        { module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001', deploymentBlock: 100 },
      ]),
    }));
    assert.equal(reordered[0]?.module, 'REPO_MARKET', 'controllers must project before child-module events');
    assert.throws(() => parseV2DeploymentSources(loadConfig({
      ...requiredConfig,
      V2_DEPLOYMENTS_JSON: JSON.stringify([
        { module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001', deploymentBlock: 100 },
        { module: 'DUTCH_AUCTION', address: '0x0000000000000000000000000000000000000002', deploymentBlock: 100 },
      ]),
    })), /requires metadata.controllerAddress/);
    assert.throws(() => parseV2DeploymentSources(loadConfig({
      ...requiredConfig,
      V2_DEPLOYMENTS_JSON: JSON.stringify([
        { module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001', deploymentBlock: 100 },
        { module: 'RISK_MANAGER', address: '0x0000000000000000000000000000000000000001', deploymentBlock: 100 },
      ]),
    })), /Duplicate V2 deployment/);
  });

  it('detects checkpoint reorgs case-insensitively and bounds durable retries', () => {
    assert.equal(canonicalCheckpointMatches('0xABCD', '0xabcd'), true);
    assert.equal(canonicalCheckpointMatches('0xABCD', '0xdead'), false);
    assert.equal(automationRetryDelayMs(1), 5_000);
    assert.equal(automationRetryDelayMs(99), 15 * 60_000);
    assert.equal(isSupportedV2JobAction('startAuction'), true);
    assert.equal(isSupportedV2JobAction('unknown'), false);
    assert.equal(isSupportedV2JobAction('materializeLiquidationClaim'), true);
  });

  it('only reclaims expired automation leases', () => {
    const now = new Date('2026-08-08T00:10:00.000Z');
    assert.equal(isAutomationLeaseClaimable('PENDING', new Date('2026-08-08T00:09:59.000Z'), null, now), true);
    assert.equal(isAutomationLeaseClaimable('RUNNING', now, new Date('2026-08-08T00:09:00.000Z'), now), false);
    assert.equal(isAutomationLeaseClaimable('RUNNING', now, new Date('2026-08-08T00:07:59.000Z'), now), true);
    assert.equal(isAutomationLeaseClaimable('SUBMITTED', new Date('2026-08-08T00:09:59.000Z'), null, now), true);
    assert.equal(isAutomationLeaseClaimable('SUBMITTED', new Date('2026-08-08T00:10:01.000Z'), null, now), false);
    assert.equal(isAutomationLeaseClaimable('SUCCEEDED', new Date(0), null, now), false);
  });

  it('accepts only complete byte-aligned signed transaction envelopes', () => {
    const signed = '0x010203' as const;
    assert.equal(isSignedAutomationTransaction(signed), true);
    assert.equal(keccak256(signed).length, 66);
    assert.equal(isSignedAutomationTransaction('0x123'), false);
    assert.equal(isSignedAutomationTransaction('0xnothex'), false);
    assert.equal(isSignedAutomationTransaction(undefined), false);
  });

  it('projects the exact final OfferFilled ABI without undefined immutable terms', () => {
    const buyer = '0x00000000000000000000000000000000000000b0' as const;
    const openingValuationDigest = `0x${'ab'.repeat(32)}` as const;
    const topics = encodeEventTopics({
      abi: repoMarketV2Abi,
      eventName: 'OfferFilled',
      args: { offerId: 7n, positionId: 9n, buyer },
    });
    const data = encodeAbiParameters([
      { name: 'principal', type: 'uint256' },
      { name: 'collateral', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'maturity', type: 'uint256' },
      { name: 'repaymentDeadline', type: 'uint256' },
      { name: 'defaultAnnualRateBps', type: 'uint256' },
      { name: 'liquidationFeeBps', type: 'uint256' },
      { name: 'auctionStartBps', type: 'uint256' },
      { name: 'auctionFloorBps', type: 'uint256' },
      { name: 'auctionDuration', type: 'uint256' },
      { name: 'maxOracleAge', type: 'uint256' },
      { name: 'staleOracleFallbackDelay', type: 'uint256' },
      { name: 'openingValuationDigest', type: 'bytes32' },
    ], [1_000_000n, 2_000_000n, 1_500n, 10_000n, 10_600n, 775n, 125n, 11_000n, 7_500n, 900n, 300n, 3_600n, openingValuationDigest]);
    const decoded = decodeEventLog({ abi: repoMarketV2Abi, eventName: 'OfferFilled', topics, data });
    const snapshot = offerFilledPositionSnapshot(decoded.args as unknown as Record<string, unknown>);
    assert.deepEqual(snapshot, {
      defaultRateBps: 775,
      liquidationFeeBps: 125,
      auctionStartBps: 11_000,
      auctionFloorBps: 7_500,
      auctionDurationSeconds: 900,
      maxOracleAgeSeconds: 300,
      staleOracleFallbackDelaySeconds: 3_600,
      openingValuationDigest,
    });
    assert.throws(
      () => offerFilledPositionSnapshot({ liquidationFeeBps: 125n }),
      /openingValuationDigest/,
    );
  });
});
