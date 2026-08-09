import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoMarketV2Abi } from '@rwcar/shared';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import { loadConfig, parseV2DeploymentSources } from '../src/config.js';
import { keeperCheckpointState, keeperRetryKey } from '../src/keeper.js';
import { resolveOracleHeartbeatTargets, shouldPublishOracleHeartbeat } from '../src/oracle-heartbeat.js';
import { jsonSafe } from '../src/projector.js';
import {
  automationRetryDelayMs,
  durableLifecycleRetryDelayMs,
  isAutomationLeaseClaimable,
  isSignedAutomationTransaction,
  isSupportedV2JobAction,
  preparedTransactionMaxCost,
  replacementFee,
  staleAutomationTransactionReason,
  v2AutomationCheckpointState,
} from '../src/v2-keeper.js';
import { canonicalCheckpointMatches, v2Consumer } from '../src/v2-indexer.js';
import { bytes32Label, offerFilledPositionSnapshot } from '../src/v2-projector.js';

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

  it('normalizes zero and padded vault ledger labels without PostgreSQL NUL bytes', () => {
    assert.equal(bytes32Label(`0x${'00'.repeat(32)}`), 'NONE');
    assert.equal(bytes32Label(stringToHex('DEPOSIT', { size: 32 })), 'DEPOSIT');
    assert.equal(bytes32Label('\0'), 'NONE');
    assert.equal(bytes32Label(`0x${'ff'.repeat(32)}`), `0x${'ff'.repeat(32)}`);
  });

  it('defaults log scans to Monad-compatible 100-block batches', () => {
    const config = loadConfig(requiredConfig);
    assert.equal(config.INDEXER_BATCH_SIZE, 100n);
    assert.equal(config.INDEXER_CATCHUP_DELAY_MS, 100);
    assert.equal(config.V1_INDEXER_ENABLED, true);
    assert.equal(config.V1_KEEPER_ENABLED, true);
    assert.equal(config.V2_AUTOMATION_MAX_CHECKPOINT_LAG, 100n);
    assert.equal(config.V2_ORACLE_HEARTBEAT_ENABLED, false);
    assert.equal(config.V2_ORACLE_HEARTBEAT_INTERVAL_MS, 600_000);
  });

  it('supports a V2-only low-overhead runtime without weakening V2 automation', () => {
    const config = loadConfig({
      ...requiredConfig,
      V1_INDEXER_ENABLED: 'false',
      V1_KEEPER_ENABLED: 'false',
      INDEXER_CATCHUP_DELAY_MS: '250',
    });
    assert.equal(config.V1_INDEXER_ENABLED, false);
    assert.equal(config.V1_KEEPER_ENABLED, false);
    assert.equal(config.INDEXER_CATCHUP_DELAY_MS, 250);
  });

  it('accepts a verified provider range and rejects unbounded log scans', () => {
    assert.equal(loadConfig({ ...requiredConfig, INDEXER_BATCH_SIZE: '1000' }).INDEXER_BATCH_SIZE, 1_000n);
    assert.throws(() => loadConfig({ ...requiredConfig, INDEXER_BATCH_SIZE: '1001' }));
  });

  it('keeps default automation optional and validates configured signing keys', () => {
    assert.equal(loadConfig(requiredConfig).KEEPER_PRIVATE_KEY, undefined);
    assert.throws(() => loadConfig({ ...requiredConfig, KEEPER_PRIVATE_KEY: 'not-a-private-key' }));
    assert.equal(
      loadConfig({ ...requiredConfig, KEEPER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }).KEEPER_POLL_MS,
      10_000,
    );
    assert.equal(loadConfig(requiredConfig).V2_AUTOMATION_STALE_TX_MS, 120_000);
    assert.throws(() => loadConfig({ ...requiredConfig, V2_AUTOMATION_STALE_TX_MS: '59999' }));
  });

  it('requires a complete, distinct two-signer configuration for an enabled oracle heartbeat', () => {
    const base = {
      ...requiredConfig,
      KEEPER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      V2_SETTLEMENT_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000010',
      V2_ORACLE_HEARTBEAT_ENABLED: 'true',
      V2_ORACLE_HEARTBEAT_PRICE_E18: '1000000000000000000',
      V2_ORACLE_HEARTBEAT_EVIDENCE_HASH: `0x${'ab'.repeat(32)}`,
      V2_ORACLE_SIGNER_1_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      V2_ORACLE_SIGNER_2_PRIVATE_KEY: `0x${'3'.repeat(64)}`,
    };
    assert.equal(loadConfig(base).V2_ORACLE_HEARTBEAT_ENABLED, true);
    assert.throws(() => loadConfig({ ...base, V2_ORACLE_SIGNER_2_PRIVATE_KEY: base.V2_ORACLE_SIGNER_1_PRIVATE_KEY }));
    assert.throws(() => loadConfig({ ...base, V2_ORACLE_HEARTBEAT_INTERVAL_MS: '299999' }));
    assert.throws(() => loadConfig({ ...base, V2_ORACLE_HEARTBEAT_EVIDENCE_HASH: undefined }));
  });

  it('publishes oracle heartbeats only at the configured boundary', () => {
    assert.equal(shouldPublishOracleHeartbeat(1_000n, 1_599n, 600n), false);
    assert.equal(shouldPublishOracleHeartbeat(1_000n, 1_600n, 600n), true);
    assert.equal(shouldPublishOracleHeartbeat(0n, 1n, 600n), true);
  });

  it('resolves one oracle and one shared collateral asset from deployment metadata', () => {
    const sources = parseV2DeploymentSources(loadConfig({
      ...requiredConfig,
      V2_DEPLOYMENTS_JSON: JSON.stringify([
        { module: 'REPO_MARKET', address: '0x0000000000000000000000000000000000000001', deploymentBlock: 100 },
        { module: 'VALUATION_ORACLE', address: '0x0000000000000000000000000000000000000002', deploymentBlock: 100 },
        {
          module: 'COLLATERAL_VAULT',
          address: '0x0000000000000000000000000000000000000003',
          deploymentBlock: 100,
          metadata: {
            controllerAddress: '0x0000000000000000000000000000000000000001',
            asset: '0x0000000000000000000000000000000000000004',
          },
        },
      ]),
    }));
    assert.deepEqual(resolveOracleHeartbeatTargets(sources), {
      oracle: '0x0000000000000000000000000000000000000002',
      asset: '0x0000000000000000000000000000000000000004',
    });
    assert.throws(() => resolveOracleHeartbeatTargets(sources.filter((source) => source.module !== 'VALUATION_ORACLE')));
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

  it('admits V2 automation only from a complete bounded finalized snapshot', () => {
    assert.equal(v2AutomationCheckpointState([], 2, 1_000n, 3n, 100n).ready, false);
    assert.equal(v2AutomationCheckpointState([900n], 2, 1_000n, 3n, 100n).ready, false);
    assert.deepEqual(v2AutomationCheckpointState([897n, 950n], 2, 1_000n, 3n, 100n), {
      ready: true,
      finalizedBlock: 997n,
      minimumBlock: 897n,
    });
    assert.equal(v2AutomationCheckpointState([896n, 997n], 2, 1_000n, 3n, 100n).ready, false);
    assert.equal(v2AutomationCheckpointState([997n, 1_001n], 2, 1_000n, 3n, 100n).ready, false);
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
    assert.equal(durableLifecycleRetryDelayMs(1), 5_000);
    assert.equal(durableLifecycleRetryDelayMs(99), 60_000);
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

  it('replaces only signed transactions proven stale by nonce and age', () => {
    const now = new Date('2026-08-09T13:30:00.000Z');
    const common = {
      transactionNonce: 7n,
      latestNonce: 7n,
      pendingNonce: 7n,
      preparedAt: new Date('2026-08-09T13:27:59.000Z'),
      now,
      staleAfterMs: 120_000,
    };
    assert.equal(staleAutomationTransactionReason(common), 'MISSING_FROM_PENDING_POOL');
    assert.equal(staleAutomationTransactionReason({ ...common, pendingNonce: 8n }), null);
    assert.equal(staleAutomationTransactionReason({ ...common, preparedAt: new Date('2026-08-09T13:29:00.001Z') }), null);
    assert.equal(staleAutomationTransactionReason({ ...common, latestNonce: 8n, pendingNonce: 8n }), 'NONCE_CONSUMED');
    assert.equal(staleAutomationTransactionReason({ ...common, transactionNonce: null }), null);
  });

  it('prices a same-nonce replacement above both the original and current fee', () => {
    assert.equal(replacementFee(100n, 90n), 113n);
    assert.equal(replacementFee(100n, 150n), 150n);
    assert.equal(replacementFee(undefined, 150n), 150n);
    assert.equal(preparedTransactionMaxCost(617_335n, 122_000_000_000n), 75_314_870_000_000_000n);
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
