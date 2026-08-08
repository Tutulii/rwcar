import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(root, 'artifacts-solc', `${name}.json`), 'utf8'));
const duration = 300;
const grace = 120;
const priceE18 = 100n * 10n ** 18n;
const chain = defineChain({
  id: 31_337, name: 'Ganache', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

async function receipt(client, hash) {
  const result = await client.waitForTransactionReceipt({ hash });
  assert.equal(result.status, 'success');
  return result;
}

describe('MarginEngineV2 master netting set', () => {
  let provider, publicClient, wallets, owner, seller, lenderA, lenderB, bidder, treasury, signerB, signerC;
  let validator, settlement, asset, registry, oracle, risk, factory, engine, vault, auction, escrow;
  let snapshotId, oracleNonce;

  const deploy = async (name, args = []) => {
    const compiled = artifact(name);
    const hash = await owner.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args, gas: 20_000_000n });
    const result = await receipt(publicClient, hash);
    return { address: result.contractAddress, abi: compiled.abi };
  };
  const write = (wallet, contract, functionName, args = []) => wallet.writeContract({
    address: contract.address, abi: contract.abi, functionName, args, gas: 20_000_000n,
  });
  const read = (contract, functionName, args = []) => publicClient.readContract({
    address: contract.address, abi: contract.abi, functionName, args,
  });

  const submitPrice = async (price = priceE18) => {
    oracleNonce += 1n;
    const block = await publicClient.getBlock();
    const message = {
      asset: asset.address, settlementToken: settlement.address, priceE18: price,
      observedAt: block.timestamp, validUntil: block.timestamp + 20_000n, nonce: oracleNonce,
      evidenceHash: `0x${oracleNonce.toString(16).padStart(64, '0')}`,
    };
    const typed = {
      domain: { name: 'RWCAR Signed Valuation Oracle', version: '2', chainId: chain.id, verifyingContract: oracle.address },
      types: { Attestation: [
        { name: 'asset', type: 'address' }, { name: 'settlementToken', type: 'address' },
        { name: 'priceE18', type: 'uint256' }, { name: 'observedAt', type: 'uint64' },
        { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
        { name: 'evidenceHash', type: 'bytes32' },
      ] }, primaryType: 'Attestation', message,
    };
    const signatures = await Promise.all([owner.signTypedData(typed), signerB.signTypedData(typed)]);
    await receipt(publicClient, await write(bidder, oracle, 'submit', [message, signatures]));
  };

  const fund = async (wallet, principal) => {
    const id = await read(engine, 'nextExposureId');
    await receipt(publicClient, await write(wallet, engine, 'fundMarginAccount', [1n, principal, 575, 20_000_000n]));
    return id;
  };

  before(async () => {
    provider = ganache.provider({
      logging: { quiet: true }, chain: { chainId: chain.id, allowUnlimitedContractSize: false },
      miner: { blockGasLimit: 30_000_000 }, wallet: { deterministic: true, totalAccounts: 10 },
    });
    const addresses = await provider.request({ method: 'eth_accounts', params: [] });
    const initial = provider.getInitialAccounts();
    wallets = addresses.map((address) => createWalletClient({
      account: privateKeyToAccount(initial[address.toLowerCase()].secretKey), chain, transport: custom(provider),
    }));
    [owner, seller, lenderA, lenderB, bidder, treasury, signerB, signerC] = wallets;
    publicClient = createPublicClient({ chain, transport: custom(provider) });
    oracleNonce = 0n;

    validator = await deploy('MockComplianceValidator');
    settlement = await deploy('MockERC20', ['Access USDC', 'aUSDC', 6]);
    asset = await deploy('MockERC20', ['RWCAR Receivable Note I', 'RWRN01', 6]);
    registry = await deploy('CvaAssetRegistry', [owner.account.address]);
    oracle = await deploy('SignedValuationOracle', [owner.account.address, [owner.account.address, signerB.account.address, signerC.account.address]]);
    risk = await deploy('RiskManagerV2', [owner.account.address, 0]);
    factory = await deploy('ProtocolModuleFactoryV2', [owner.account.address, validator.address]);
    await receipt(publicClient, await write(owner, registry, 'setAsset', [asset.address, true, 6, `0x${'33'.repeat(32)}`]));
    const config = {
      enabled: true, initialLtvBps: 7_000, maintenanceLtvBps: 7_500, liquidationLtvBps: 8_000,
      auctionStartBps: 10_500, auctionFloorBps: 8_000, liquidationFeeBps: 50,
      earlyMinHoldBps: 1_000, earlyBreakFeeBps: 10, defaultSpreadBps: 500, maxDefaultRateBps: 2_500,
      maxOracleAge: 20_000, auctionDuration: 60, marginCallPeriod: 120, staleOracleFallbackDelay: 180,
    };
    await receipt(publicClient, await write(owner, risk, 'scheduleConfig', [asset.address, config]));
    await receipt(publicClient, await write(owner, risk, 'applyConfig', [asset.address, config]));
    engine = await deploy('MarginEngineV2', [
      owner.account.address, settlement.address, asset.address, validator.address, registry.address,
      oracle.address, risk.address, factory.address, treasury.account.address, 15, grace, [duration],
    ]);
    vault = { address: await read(engine, 'vault'), abi: artifact('CollateralVaultV2').abi };
    auction = { address: await read(engine, 'auctionHouse'), abi: artifact('DutchAuctionV2').abi };
    escrow = { address: await read(engine, 'settlementEscrow'), abi: artifact('SettlementEscrowV2').abi };
    await receipt(publicClient, await write(owner, engine, 'setCleanverseCustodyReady', [true]));
    for (const wallet of [owner, seller, lenderA, lenderB, bidder, treasury]) {
      await receipt(publicClient, await write(owner, validator, 'setCompliant', [wallet.account.address, true]));
    }
    await receipt(publicClient, await write(owner, asset, 'mint', [seller.account.address, 100_000_000n]));
    await receipt(publicClient, await write(seller, asset, 'approve', [vault.address, 100_000_000n]));
    for (const wallet of [seller, lenderA, lenderB, bidder]) {
      await receipt(publicClient, await write(owner, settlement, 'mint', [wallet.account.address, 50_000_000_000n]));
      await receipt(publicClient, await write(wallet, settlement, 'approve', [engine.address, 2n ** 255n]));
    }
    await submitPrice();
    await receipt(publicClient, await write(seller, engine, 'depositCollateral', [100_000_000n]));
    const fundingExpiry = (await publicClient.getBlock()).timestamp + 20_000n;
    await receipt(publicClient, await write(seller, engine, 'openMarginAccount', [{
      collateralAmount: 100_000_000n,
      fundingTarget: 10_000_000_000n,
      minimumFunding: 1n,
      maxAnnualRateBps: 575,
      duration,
      fundingExpiry,
      permittedLender: '0x0000000000000000000000000000000000000000',
    }]));
    snapshotId = await provider.request({ method: 'evm_snapshot', params: [] });
  });

  beforeEach(async () => {
    await provider.request({ method: 'evm_revert', params: [snapshotId] });
    snapshotId = await provider.request({ method: 'evm_snapshot', params: [] });
    oracleNonce = 1n;
  });

  it('keeps risk-reducing collateral deposits available while new entry is paused', async () => {
    await receipt(publicClient, await write(owner, engine, 'setEntryPaused', [true]));
    await receipt(publicClient, await write(owner, asset, 'mint', [seller.account.address, 1_000_000n]));
    await receipt(publicClient, await write(seller, asset, 'approve', [vault.address, 1_000_000n]));
    await receipt(publicClient, await write(seller, engine, 'depositCollateral', [1_000_000n]));
    assert.equal(await read(vault, 'availableBalance', [seller.account.address]), 1_000_000n);
  });

  it('rejects governance risk rates above the protocol hard cap', async () => {
    const live = await read(risk, 'rawConfig', [asset.address]);
    const invalid = { ...live, maxDefaultRateBps: 100_001 };
    await assert.rejects(() => receipt(
      publicClient,
      write(owner, risk, 'scheduleConfig', [asset.address, invalid]),
    ));
  });

  it('enforces the seller-authored funding mandate and live CVA admission', async () => {
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [1n, 1_000_000n, 576, 20_000_000n]),
    ));
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [1n, 10_000_000_001n, 575, 20_000_000n]),
    ));
    await receipt(publicClient, await write(owner, registry, 'setAsset', [asset.address, false, 6, `0x${'33'.repeat(32)}`]));
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [1n, 1_000_000n, 575, 20_000_000n]),
    ));
  });

  it('enforces an optional permitted lender on the funding mandate', async () => {
    await receipt(publicClient, await write(seller, engine, 'closeMarginAccount', [1n]));
    const fundingExpiry = (await publicClient.getBlock()).timestamp + 20_000n;
    await receipt(publicClient, await write(seller, engine, 'openMarginAccount', [{
      collateralAmount: 100_000_000n,
      fundingTarget: 2_000_000n,
      minimumFunding: 1_500_000n,
      maxAnnualRateBps: 575,
      duration,
      fundingExpiry,
      permittedLender: lenderA.account.address,
    }]));
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderB, engine, 'fundMarginAccount', [2n, 1_000_000n, 575, 20_000_000n]),
    ));
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [2n, 1_000_000n, 575, 20_000_000n]),
    ));
    await receipt(publicClient, await write(lenderA, engine, 'fundMarginAccount', [2n, 2_000_000n, 575, 20_000_000n]));
    assert.equal((await read(engine, 'getAccount', [2n])).fundingClosed, true);
  });

  it('lets the seller permanently close the unfilled funding mandate', async () => {
    await receipt(publicClient, await write(seller, engine, 'closeFunding', [1n]));
    assert.equal((await read(engine, 'getAccount', [1n])).fundingClosed, true);
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [1n, 1_000_000n, 575, 20_000_000n]),
    ));
  });

  it('rejects funding after the seller-authored mandate expires', async () => {
    await provider.request({ method: 'evm_increaseTime', params: [20_001] });
    await provider.request({ method: 'evm_mine', params: [] });
    await assert.rejects(() => receipt(
      publicClient,
      write(lenderA, engine, 'fundMarginAccount', [1n, 1_000_000n, 575, 20_000_000n]),
    ));
  });

  it('closes cleanly after a debt-free account withdraws all collateral', async () => {
    await receipt(publicClient, await write(seller, engine, 'withdrawExcessCollateral', [1n, 100_000_000n, seller.account.address]));
    assert.equal((await read(engine, 'getAccount', [1n])).collateralAmount, 0n);
    await receipt(publicClient, await write(seller, engine, 'closeMarginAccount', [1n]));
    assert.equal((await read(engine, 'getAccount', [1n])).status, 6);
  });

  it('keeps liquidation live when the oracle value rounds below one settlement unit', async () => {
    await fund(lenderA, 1_000_000n);
    await submitPrice(1n);
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const account = await read(engine, 'getAccount', [1n]);
    const liveAuction = await read(auction, 'getAuction', [account.auctionId]);
    assert.equal(liveAuction.floorPrice, 1n);
  });

  it('aggregates fixed face debt in O(1) and repays an exposure without touching shared collateral', async () => {
    const first = await fund(lenderA, 2_000_000_000n);
    await fund(lenderB, 3_000_000_000n);
    const account = await read(engine, 'getAccount', [1n]);
    assert.equal(account.activeExposureCount, 2);
    assert(account.totalFaceDebt > 5_000_000_000n);
    const exposure = await read(engine, 'getExposure', [first]);
    await receipt(publicClient, await write(seller, engine, 'repayExposure', [first, exposure.faceDebt, false]));
    const after = await read(engine, 'getAccount', [1n]);
    assert.equal(after.activeExposureCount, 1);
    assert.equal((await read(vault, 'marginBucket', [1n])).amount, 100_000_000n);
  });

  it('opens a maintenance margin call and cures it against a fresh higher valuation', async () => {
    await fund(lenderA, 5_000_000_000n);
    await submitPrice(65n * 10n ** 18n);
    const stressedLtv = await read(engine, 'accountLtv', [1n]);
    assert(stressedLtv > 7_500n && stressedLtv < 8_000n);
    await receipt(publicClient, await write(bidder, engine, 'openMarginCall', [1n]));
    assert.equal((await read(engine, 'getAccount', [1n])).status, 2);
    await submitPrice(100n * 10n ** 18n);
    await receipt(publicClient, await write(bidder, engine, 'cureMarginCall', [1n]));
    const cured = await read(engine, 'getAccount', [1n]);
    assert.equal(cured.status, 1);
    assert.equal(cured.marginCallDeadline, 0n);
  });

  it('liquidates an uncured margin call after its immutable cure deadline', async () => {
    await fund(lenderA, 5_000_000_000n);
    await submitPrice(65n * 10n ** 18n);
    await receipt(publicClient, await write(bidder, engine, 'openMarginCall', [1n]));
    await provider.request({ method: 'evm_increaseTime', params: [121] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const liquidating = await read(engine, 'getAccount', [1n]);
    assert.equal(liquidating.status, 3);
    assert(liquidating.auctionId > 0n);
  });

  it('uses the delayed in-kind lender fallback only after a declared default and stale oracle', async () => {
    const exposureId = await fund(lenderA, 2_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [20_001] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [exposureId]));
    await assert.rejects(() => receipt(
      publicClient,
      write(bidder, engine, 'startInKindOracleFallback', [1n]),
    ));
    await provider.request({ method: 'evm_increaseTime', params: [181] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'startInKindOracleFallback', [1n]));
    const closed = await read(engine, 'getAccount', [1n]);
    assert.equal(closed.status, 5);
    assert.equal(closed.inKindCloseout, true);
    assert.equal(closed.unclaimedExposureCount, 1);
  });

  it('cross-defaults the netting set and distributes auction recovery pari passu without lender loops', async () => {
    const first = await fund(lenderA, 2_000_000_000n);
    const second = await fund(lenderB, 3_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [first]));
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const account = await read(engine, 'getAccount', [1n]);
    const price = await read(auction, 'currentPrice', [account.auctionId]);
    await receipt(publicClient, await write(bidder, engine, 'buyMarginAuction', [account.auctionId, price]));
    await receipt(publicClient, await write(owner, validator, 'setCompliant', [lenderA.account.address, false]));
    await receipt(publicClient, await write(bidder, engine, 'materializeLiquidationClaim', [first]));
    await receipt(publicClient, await write(bidder, engine, 'materializeLiquidationClaim', [second]));
    const closed = await read(engine, 'getAccount', [1n]);
    assert.equal(closed.remainingProceeds, 0n);
    assert.equal(closed.unclaimedExposureCount, 0);
    assert.equal(await read(asset, 'balanceOf', [bidder.account.address]), 100_000_000n);
    assert.equal(await read(escrow, 'totalClaims'), await read(settlement, 'balanceOf', [escrow.address]));
    assert((await read(escrow, 'claimable', [lenderA.account.address])) > 0n);
  });

  it('freezes the lender set at liquidation and rejects individual repayment afterwards', async () => {
    const first = await fund(lenderA, 2_000_000_000n);
    await fund(lenderB, 3_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [first]));
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const exposure = await read(engine, 'getExposure', [first]);
    await assert.rejects(() => receipt(
      publicClient,
      write(seller, engine, 'repayExposure', [first, exposure.faceDebt, false]),
    ));
    assert.equal((await read(engine, 'getExposure', [first])).status, 1);
    assert.equal((await read(engine, 'getAccount', [1n])).unclaimedExposureCount, 2);
  });

  it('allows a zero-rounded proceeds allocation to close so final-claim dust cannot strand', async () => {
    const tiny = await fund(lenderA, 2n);
    const large = await fund(lenderB, 5_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await submitPrice(1n * 10n ** 18n);
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [tiny]));
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const account = await read(engine, 'getAccount', [1n]);
    // Keep a deterministic buffer before the 60-second auction deadline. The
    // pure-JS Ganache fallback may advance the next transaction by a block.
    await provider.request({ method: 'evm_increaseTime', params: [50] });
    await provider.request({ method: 'evm_mine', params: [] });
    const price = await read(auction, 'currentPrice', [account.auctionId]);
    await receipt(publicClient, await write(bidder, engine, 'buyMarginAuction', [account.auctionId, price]));
    await receipt(publicClient, await write(bidder, engine, 'materializeLiquidationClaim', [tiny]));
    assert.equal((await read(engine, 'getExposure', [tiny])).status, 3);
    assert.equal((await read(engine, 'getAccount', [1n])).unclaimedExposureCount, 1);
    await receipt(publicClient, await write(bidder, engine, 'materializeLiquidationClaim', [large]));
    const closed = await read(engine, 'getAccount', [1n]);
    assert.equal(closed.unclaimedExposureCount, 0);
    assert.equal(closed.remainingProceeds, 0n);
  });

  it('gives failed-auction collateral to lenders pro rata and assigns all rounding dust', async () => {
    const first = await fund(lenderA, 2_000_000_000n);
    const second = await fund(lenderB, 3_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [first]));
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const account = await read(engine, 'getAccount', [1n]);
    await provider.request({ method: 'evm_increaseTime', params: [61] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'finalizeFailedMarginAuction', [account.auctionId]));
    await receipt(publicClient, await write(lenderA, engine, 'claimFailedCollateral', [first, lenderA.account.address]));
    await receipt(publicClient, await write(lenderB, engine, 'claimFailedCollateral', [second, lenderB.account.address]));
    assert.equal(
      (await read(asset, 'balanceOf', [lenderA.account.address])) + (await read(asset, 'balanceOf', [lenderB.account.address])),
      100_000_000n,
    );
    assert.equal(await read(vault, 'totalAccounted'), 0n);
  });

  it('allows zero-rounded in-kind claims to close before final collateral dust is assigned', async () => {
    const tiny = await fund(lenderA, 2n);
    const large = await fund(lenderB, 5_000_000_000n);
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'declarePaymentDefault', [tiny]));
    await receipt(publicClient, await write(bidder, engine, 'startMarginLiquidation', [1n]));
    const account = await read(engine, 'getAccount', [1n]);
    await provider.request({ method: 'evm_increaseTime', params: [61] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, engine, 'finalizeFailedMarginAuction', [account.auctionId]));
    await receipt(publicClient, await write(lenderA, engine, 'claimFailedCollateral', [tiny, lenderA.account.address]));
    assert.equal((await read(engine, 'getExposure', [tiny])).status, 4);
    assert.equal((await read(engine, 'getAccount', [1n])).unclaimedExposureCount, 1);
    await receipt(publicClient, await write(lenderB, engine, 'claimFailedCollateral', [large, lenderB.account.address]));
    const closed = await read(engine, 'getAccount', [1n]);
    assert.equal(closed.unclaimedExposureCount, 0);
    assert.equal(closed.remainingCollateral, 0n);
    assert.equal(await read(vault, 'totalAccounted'), 0n);
  });
});
