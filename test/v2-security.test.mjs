import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData } from 'viem';
import { marginEngineV2Abi } from '../packages/shared/src/v2-abis.ts';
import {
  assertV2Instruction,
  compareApiConfigToManifest,
  validateApprovalInstructions,
  verifyManifestRuntimeCode,
} from '../src/lib/v2-security.js';
import {
  pendingForWallet,
  readPendingExecutions,
  removePendingExecution,
  upsertPendingExecution,
} from '../src/lib/v2-pending.js';
import { normalizeWalletProviderError, sendTransaction } from '../src/lib/chain.js';

const address = (value) => `0x${value.toString(16).padStart(40, '0')}`;
const hash = (value) => `0x${value.toString(16).padStart(64, '0')}`;

const manifest = {
  schemaVersion: 1,
  protocolVersion: 'v2',
  status: 'ACTIVE',
  chainId: 10_143,
  deploymentId: 'test-reviewed-release',
  contracts: {
    repoMarket: { address: address(1), runtimeCodeHash: hash(101) },
    collateralVault: { address: address(2), runtimeCodeHash: hash(102) },
    auctionHouse: { address: address(3), runtimeCodeHash: hash(103) },
    settlementEscrow: { address: address(4), runtimeCodeHash: hash(104) },
    marginEngine: { address: address(5), runtimeCodeHash: hash(105) },
    marginVault: { address: address(6), runtimeCodeHash: hash(106) },
    marginAuctionHouse: { address: address(7), runtimeCodeHash: hash(107) },
    marginSettlementEscrow: { address: address(8), runtimeCodeHash: hash(108) },
    valuationOracle: { address: address(9), runtimeCodeHash: hash(109) },
    riskManager: { address: address(10), runtimeCodeHash: hash(110) },
  },
  settlementToken: { address: address(11), symbol: 'aUSDC', decimals: 6, runtimeCodeHash: hash(111) },
  marginAsset: { address: address(12), symbol: 'RWRN01', name: 'RWCAR Note', decimals: 6, runtimeCodeHash: hash(112) },
  assets: [{ address: address(12), vault: address(2), symbol: 'RWRN01', decimals: 6, runtimeCodeHash: hash(112) }],
};

const apiConfig = {
  chainId: 10_143,
  contracts: {
    repoMarket: address(1),
    collateralVault: address(2),
    auctionHouse: address(3),
    settlementEscrow: address(4),
    marginEngine: address(5),
    valuationOracle: address(9),
    riskManager: address(10),
  },
  settlementToken: { address: address(11), symbol: 'aUSDC', decimals: 6 },
  assets: [{ address: address(12), vault: address(2), decimals: 6 }],
  readiness: {
    triPartyVault: { assetProofs: [{ asset: address(12), vault: address(2) }] },
    crossMargin: { proof: { asset: address(12), vault: address(6), auctionHouse: address(7), settlementEscrow: address(8) } },
  },
};

describe('browser V2 signing boundary', () => {
  it('rejects API deployment substitution and any runtime-code mismatch', async () => {
    assert.deepEqual(compareApiConfigToManifest(apiConfig, manifest), { ok: true, errors: [] });
    const substituted = structuredClone(apiConfig);
    substituted.contracts.repoMarket = address(99);
    assert.equal(compareApiConfigToManifest(substituted, manifest).ok, false);

    const verified = await verifyManifestRuntimeCode(manifest, async (target) => {
      const entry = [
        ...Object.values(manifest.contracts), manifest.settlementToken, manifest.marginAsset, ...manifest.assets,
      ].find((candidate) => candidate.address.toLowerCase() === target.toLowerCase());
      return entry.runtimeCodeHash;
    });
    assert.equal(verified.ok, true);
    const mismatched = await verifyManifestRuntimeCode(manifest, async () => hash(999));
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.errors.some((error) => error.startsWith('CODE_HASH_MISMATCH:')));
  });

  it('allows only the exact action-specific approval tuple', () => {
    const body = { actor: address(20), offerId: '7', principalAmount: '1000000' };
    const result = { requiredApprovals: [{ token: address(11), spender: address(1), amount: '1000000' }] };
    assert.equal(validateApprovalInstructions('fill', body, result, apiConfig).length, 1);
    assert.throws(() => validateApprovalInstructions('fill', body, {
      requiredApprovals: [{ token: address(11), spender: address(1), amount: (2n ** 256n - 1n).toString() }],
    }, apiConfig), /does not exactly match/);
    assert.throws(() => validateApprovalInstructions('withdraw', { actor: address(20), amount: '1' }, result, apiConfig), /unexpected approval/);
  });

  it('binds every open-account calldata field to the reviewed funding mandate', () => {
    const body = {
      actor: address(20), action: 'OPEN_ACCOUNT', amount: '5000000', fundingTarget: '3000000',
      minimumFunding: '1000000', maxAnnualRateBps: 800, durationSeconds: 604800,
      fundingExpiry: 1_786_000_000, permittedLender: null,
    };
    const params = {
      collateralAmount: 5_000_000n, fundingTarget: 3_000_000n, minimumFunding: 1_000_000n,
      maxAnnualRateBps: 800, duration: 604_800n, fundingExpiry: 1_786_000_000n,
      permittedLender: '0x0000000000000000000000000000000000000000',
    };
    const data = encodeFunctionData({ abi: marginEngineV2Abi, functionName: 'openMarginAccount', args: [params] });
    assert.doesNotThrow(() => assertV2Instruction(
      'margin-action', { to: address(5), data, value: '0' }, apiConfig, body, { quote: { amounts: {} } }, 0, 1,
    ));
    const tampered = encodeFunctionData({
      abi: marginEngineV2Abi,
      functionName: 'openMarginAccount',
      args: [{ ...params, maxAnnualRateBps: 801 }],
    });
    assert.throws(() => assertV2Instruction(
      'margin-action', { to: address(5), data: tampered, value: '0' }, apiConfig, body, { quote: { amounts: {} } }, 0, 1,
    ), /does not match/);
  });
});

describe('submitted transaction recovery records', () => {
  const wallet = address(20);
  const txHash = hash(500);
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  };

  it('persists, filters and clears an unknown submitted hash', () => {
    const local = storage();
    const [record] = upsertPendingExecution(local, {
      chainId: 10_143, wallet, phase: 'submitted', hash: txHash, kind: 'fill', createdAt: new Date().toISOString(),
    });
    assert.equal(readPendingExecutions(local).length, 1);
    assert.equal(pendingForWallet(local, 10_143, wallet).length, 1);
    removePendingExecution(local, record.id);
    assert.equal(readPendingExecutions(local).length, 0);
  });

  it('preserves the wallet hash when durable recovery persistence fails', async () => {
    const provider = {
      request: async ({ method }) => {
        if (method === 'eth_chainId') return '0x279f';
        if (method === 'eth_sendTransaction') return txHash;
        throw new Error(`Unexpected provider method ${method}`);
      },
    };
    const walletClient = {
      address: wallet,
      switchChain: async () => undefined,
      getEthereumProvider: async () => provider,
    };
    await assert.rejects(
      sendTransaction(walletClient, address(1), '0x12345678', {
        expectedFrom: wallet,
        onSubmitted: () => { throw new Error('storage unavailable'); },
      }),
      (error) => error.submitted === true
        && error.code === 'RECOVERY_PERSIST_FAILED'
        && error.txHash === txHash,
    );
  });

  it('turns mobile-wallet DNS failures into a concise retryable no-submission error', () => {
    const normalized = normalizeWalletProviderError(new Error('Cronet failed: net::ERR_NAME_NOT_RESOLVED InternalErrorCode=-105'));
    assert.equal(normalized.code, 'WALLET_RPC_DNS_UNAVAILABLE');
    assert.equal(normalized.retryable, true);
    assert.match(normalized.message, /No transaction was submitted/);
    assert.doesNotMatch(normalized.message, /Cronet|RuntimeException/);
  });
});
