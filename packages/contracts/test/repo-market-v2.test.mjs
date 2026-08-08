import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(root, 'artifacts-solc', `${name}.json`), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const duration = 300;
const grace = 120;
const collateral = 100_000_000n; // 100.000000 RWRN
const principal = 6_000_000_000n; // 6,000.000000 aUSDC
const priceE18 = 100n * 10n ** 18n; // 100 aUSDC per whole RWRN
const chain = defineChain({
  id: 31_337,
  name: 'Ganache',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

async function receipt(publicClient, hash) {
  const result = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(result.status, 'success');
  return result;
}

async function expectRevert(publicClient, send) {
  const hash = await send();
  const result = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(result.status, 'reverted');
}

describe('RWCAR V2 isolated repo engine', () => {
  let provider;
  let publicClient;
  let wallets;
  let owner;
  let seller;
  let buyerA;
  let buyerB;
  let bidder;
  let treasury;
  let oracleSignerB;
  let oracleSignerC;
  let validator;
  let settlement;
  let asset;
  let registry;
  let oracle;
  let risk;
  let factory;
  let market;
  let vault;
  let escrow;
  let auction;
  let nonce;
  let snapshotId;

  const deploy = async (wallet, name, args = []) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({
      abi: compiled.abi,
      bytecode: compiled.bytecode,
      args,
      gas: 15_000_000n,
    });
    const result = await receipt(publicClient, hash);
    return { address: result.contractAddress, abi: compiled.abi };
  };

  const write = (wallet, contract, functionName, args = []) => wallet.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    gas: 15_000_000n,
  });

  const read = (contract, functionName, args = []) => publicClient.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });

  const submitValuation = async (newPrice = priceE18) => {
    nonce += 1n;
    const block = await publicClient.getBlock();
    const message = {
      asset: asset.address,
      settlementToken: settlement.address,
      priceE18: newPrice,
      observedAt: block.timestamp,
      validUntil: block.timestamp + 10_000n,
      nonce,
      evidenceHash: `0x${nonce.toString(16).padStart(64, '0')}`,
    };
    const typed = {
      domain: {
        name: 'RWCAR Signed Valuation Oracle',
        version: '2',
        chainId: chain.id,
        verifyingContract: oracle.address,
      },
      types: {
        Attestation: [
          { name: 'asset', type: 'address' },
          { name: 'settlementToken', type: 'address' },
          { name: 'priceE18', type: 'uint256' },
          { name: 'observedAt', type: 'uint64' },
          { name: 'validUntil', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'evidenceHash', type: 'bytes32' },
        ],
      },
      primaryType: 'Attestation',
      message,
    };
    const signatures = await Promise.all([
      owner.signTypedData(typed),
      oracleSignerB.signTypedData(typed),
    ]);
    await receipt(publicClient, await write(bidder, oracle, 'submit', [message, signatures]));
    return message;
  };

  const createOffer = async ({
    offerCollateral = collateral,
    targetPrincipal = principal,
    minimumFill = 2_000_000_000n,
    earlyRepurchaseEnabled = true,
    expiryOffset = 3_600,
  } = {}) => {
    const block = await publicClient.getBlock();
    await receipt(publicClient, await write(seller, market, 'createOffer', [{
      asset: asset.address,
      settlementToken: settlement.address,
      collateralAmount: offerCollateral,
      targetPrincipal,
      minimumFill,
      annualRateBps: 575,
      duration,
      offerExpiry: Number(block.timestamp) + expiryOffset,
      permittedBuyer: ZERO,
      earlyRepurchaseEnabled,
    }]));
    return (await read(market, 'nextOfferId')) - 1n;
  };

  before(async () => {
    provider = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: chain.id, allowUnlimitedContractSize: false },
      miner: { blockGasLimit: 30_000_000 },
      wallet: { deterministic: true, totalAccounts: 10 },
    });
    const accounts = await provider.request({ method: 'eth_accounts', params: [] });
    const initialAccounts = provider.getInitialAccounts();
    wallets = accounts.map((address) => createWalletClient({
      account: privateKeyToAccount(initialAccounts[address.toLowerCase()].secretKey),
      chain,
      transport: custom(provider),
    }));
    [owner, seller, buyerA, buyerB, bidder, treasury, oracleSignerB, oracleSignerC] = wallets;
    publicClient = createPublicClient({ chain, transport: custom(provider) });
    nonce = 0n;

    validator = await deploy(owner, 'MockComplianceValidator');
    settlement = await deploy(owner, 'MockERC20', ['Access USDC', 'aUSDC', 6]);
    asset = await deploy(owner, 'MockERC20', ['RWCAR Receivable Note I', 'RWRN01', 6]);
    registry = await deploy(owner, 'CvaAssetRegistry', [owner.account.address]);
    oracle = await deploy(owner, 'SignedValuationOracle', [
      owner.account.address,
      [owner.account.address, oracleSignerB.account.address, oracleSignerC.account.address],
    ]);
    risk = await deploy(owner, 'RiskManagerV2', [owner.account.address, 0]);
    factory = await deploy(owner, 'ProtocolModuleFactoryV2', [owner.account.address, validator.address]);

    await receipt(publicClient, await write(owner, registry, 'setAsset', [asset.address, true, 6, `0x${'11'.repeat(32)}`]));
    const riskConfig = {
      enabled: true,
      initialLtvBps: 7_000,
      maintenanceLtvBps: 7_500,
      liquidationLtvBps: 8_000,
      auctionStartBps: 10_500,
      auctionFloorBps: 8_000,
      liquidationFeeBps: 50,
      earlyMinHoldBps: 1_000,
      earlyBreakFeeBps: 10,
      defaultSpreadBps: 500,
      maxDefaultRateBps: 2_500,
      maxOracleAge: 20_000,
      auctionDuration: 60,
      marginCallPeriod: 120,
      staleOracleFallbackDelay: 180,
    };
    await receipt(publicClient, await write(owner, risk, 'scheduleConfig', [asset.address, riskConfig]));
    await receipt(publicClient, await write(owner, risk, 'applyConfig', [asset.address, riskConfig]));

    market = await deploy(owner, 'RepoMarketV2', [
      owner.account.address,
      settlement.address,
      validator.address,
      registry.address,
      oracle.address,
      risk.address,
      factory.address,
      treasury.account.address,
      15,
      grace,
      [duration],
    ]);
    await receipt(publicClient, await write(owner, market, 'configureAsset', [asset.address]));
    const config = await read(market, 'getAssetConfig', [asset.address]);
    vault = { address: config.vault, abi: artifact('CollateralVaultV2').abi };
    escrow = { address: await read(market, 'settlementEscrow'), abi: artifact('SettlementEscrowV2').abi };
    auction = { address: await read(market, 'auctionHouse'), abi: artifact('DutchAuctionV2').abi };
    await receipt(publicClient, await write(owner, market, 'setAssetVaultReady', [asset.address, true]));

    for (const wallet of [owner, seller, buyerA, buyerB, bidder, treasury]) {
      await receipt(publicClient, await write(owner, validator, 'setCompliant', [wallet.account.address, true]));
    }
    await receipt(publicClient, await write(owner, asset, 'mint', [seller.account.address, 1_000_000_000n]));
    for (const wallet of [seller, buyerA, buyerB, bidder]) {
      await receipt(publicClient, await write(owner, settlement, 'mint', [wallet.account.address, 100_000_000_000n]));
      await receipt(publicClient, await write(wallet, settlement, 'approve', [market.address, 2n ** 255n]));
    }
    await receipt(publicClient, await write(seller, asset, 'approve', [vault.address, 2n ** 255n]));
    await submitValuation();
    await receipt(publicClient, await write(seller, market, 'depositCollateral', [asset.address, collateral]));
    snapshotId = await provider.request({ method: 'evm_snapshot', params: [] });
  });

  beforeEach(async () => {
    await provider.request({ method: 'evm_revert', params: [snapshotId] });
    snapshotId = await provider.request({ method: 'evm_snapshot', params: [] });
    nonce = 1n;
  });

  it('registers contract CVI only for exact controller-bound custody modules', async () => {
    await expectRevert(
      publicClient,
      () => write(owner, factory, 'registerCvaCustody', [market.address, asset.address, vault.address]),
    );
    await receipt(publicClient, await write(owner, validator, 'setRegistrar', [factory.address, true]));

    await expectRevert(
      publicClient,
      () => write(seller, factory, 'registerCvaCustody', [market.address, asset.address, vault.address]),
    );
    await expectRevert(
      publicClient,
      () => write(owner, factory, 'registerCvaCustody', [market.address, settlement.address, vault.address]),
    );
    await expectRevert(
      publicClient,
      () => write(owner, factory, 'registerCvaCustody', [market.address, asset.address, auction.address]),
    );

    await receipt(
      publicClient,
      await write(owner, factory, 'registerCvaCustody', [market.address, asset.address, vault.address]),
    );
    assert.equal((await read(validator, 'lastRegisteredPool')).toLowerCase(), market.address.toLowerCase());
    assert.equal((await read(validator, 'lastRegisteredAToken')).toLowerCase(), asset.address.toLowerCase());
    assert.equal((await read(validator, 'lastRegisteredFeeAddress')).toLowerCase(), vault.address.toLowerCase());
    assert.equal(await read(validator, 'registrationCount'), 1n);
    await expectRevert(
      publicClient,
      () => write(owner, factory, 'registerCvaCustody', [market.address, asset.address, vault.address]),
    );

    await receipt(
      publicClient,
      await write(owner, factory, 'registerCvaCustody', [market.address, settlement.address, escrow.address]),
    );
    assert.equal(await read(validator, 'registrationCount'), 2n);
    assert.equal((await read(validator, 'lastRegisteredFeeAddress')).toLowerCase(), escrow.address.toLowerCase());
  });

  it('normalizes 6-decimal CVA valuation into 6-decimal settlement units', async () => {
    assert.equal(await read(risk, 'collateralValue', [1_000_000n, 6, 6, priceE18]), 100_000_000n);
    assert.equal(await read(risk, 'ltvBps', [60_000_000n, 100_000_000n]), 6_000n);
  });

  it('accepts a two-of-three EIP-712 valuation and enforces increasing per-asset nonces', async () => {
    const latest = await read(oracle, 'latest', [asset.address]);
    assert.equal(latest.priceE18, priceE18);
    assert.equal(latest.nonce, 1n);

    const block = await publicClient.getBlock();
    const stale = {
      asset: asset.address,
      settlementToken: settlement.address,
      priceE18,
      observedAt: block.timestamp + 1n,
      validUntil: block.timestamp + 1_000n,
      nonce: 1n,
      evidenceHash: `0x${'22'.repeat(32)}`,
    };
    const typed = {
      domain: { name: 'RWCAR Signed Valuation Oracle', version: '2', chainId: chain.id, verifyingContract: oracle.address },
      types: { Attestation: [
        { name: 'asset', type: 'address' }, { name: 'settlementToken', type: 'address' },
        { name: 'priceE18', type: 'uint256' },
        { name: 'observedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
        { name: 'nonce', type: 'uint256' }, { name: 'evidenceHash', type: 'bytes32' },
      ] },
      primaryType: 'Attestation', message: stale,
    };
    const sigs = await Promise.all([owner.signTypedData(typed), oracleSignerB.signTypedData(typed)]);
    await expectRevert(publicClient, () => write(bidder, oracle, 'submit', [stale, sigs]));

    const scoped = { ...stale, asset: settlement.address, observedAt: block.timestamp, nonce: 1n };
    const scopedTyped = { ...typed, message: scoped };
    const scopedSigs = await Promise.all([owner.signTypedData(scopedTyped), oracleSignerB.signTypedData(scopedTyped)]);
    await receipt(publicClient, await write(bidder, oracle, 'submit', [scoped, scopedSigs]));
    assert.equal((await read(oracle, 'latest', [settlement.address])).nonce, 1n);
  });

  it('rotates the 2-of-3 signer set only after the mandatory delay', async () => {
    const nextSigners = [buyerA.account.address, buyerB.account.address, bidder.account.address];
    await receipt(publicClient, await write(owner, oracle, 'scheduleSignerSet', [nextSigners]));
    await expectRevert(publicClient, () => write(owner, oracle, 'applySignerSet', [nextSigners]));
    await provider.request({ method: 'evm_increaseTime', params: [2 * 24 * 60 * 60 + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(owner, oracle, 'applySignerSet', [nextSigners]));
    assert.equal(await read(oracle, 'isSigner', [buyerA.account.address]), true);
    assert.equal(await read(oracle, 'isSigner', [owner.account.address]), false);
  });

  it('allocates two partial fills cumulatively with no collateral or fee dust', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await receipt(publicClient, await write(buyerB, market, 'fillOffer', [offerId, 4_000_000_000n, 6_000_000n]));

    const first = await read(market, 'getPosition', [1n]);
    const second = await read(market, 'getPosition', [2n]);
    const offer = await read(market, 'getOffer', [offerId]);
    assert.equal(first.collateralAmount, 33_333_333n);
    assert.equal(second.collateralAmount, 66_666_667n);
    assert.equal(first.collateralAmount + second.collateralAmount, collateral);
    assert.equal(offer.feeCharged, 9_000_000n);
    assert.equal(offer.status, 3); // FILLED
    assert.equal(await read(vault, 'totalAccounted'), collateral);
    assert.equal((await read(vault, 'offerBucket', [offerId])).amount, 0n);
  });

  it('repurchases early using ACT/365 minimum-hold accrual and returns collateral to seller availability', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [10] });
    await provider.request({ method: 'evm_mine', params: [] });
    const block = await publicClient.getBlock();
    const payoff = await read(market, 'previewPayoff', [1n, block.timestamp]);
    assert(payoff > 2_000_000_000n);
    await receipt(publicClient, await write(seller, market, 'repurchase', [1n, payoff, false]));
    assert.equal((await read(market, 'getPosition', [1n])).status, 2); // REPAID
    assert.equal(await read(vault, 'availableBalance', [seller.account.address]), 33_333_333n);
  });

  it('escrows repayment for a frozen lender and prevents redirection until lender eligibility returns', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await receipt(publicClient, await write(owner, validator, 'setCompliant', [buyerA.account.address, false]));
    const block = await publicClient.getBlock();
    const payoff = await read(market, 'previewPayoff', [1n, block.timestamp]);
    await receipt(publicClient, await write(seller, market, 'repurchase', [1n, payoff, true]));
    assert.equal(await read(escrow, 'claimable', [buyerA.account.address]), payoff);
    assert.equal(await read(escrow, 'totalClaims'), payoff);
    await expectRevert(publicClient, () => write(buyerA, escrow, 'claim', [1n, payoff, buyerB.account.address]));
    await receipt(publicClient, await write(owner, validator, 'setCompliant', [buyerA.account.address, true]));
    const firstClaim = payoff / 2n;
    await receipt(publicClient, await write(buyerA, escrow, 'claim', [1n, firstClaim, buyerA.account.address]));
    assert.equal((await read(escrow, 'claims', [1n]))[2], payoff - firstClaim);
    await receipt(publicClient, await write(buyerA, escrow, 'claim', [1n, payoff - firstClaim, buyerA.account.address]));
    assert.equal(await read(escrow, 'totalClaims'), 0n);
  });

  it('returns only unfilled collateral when a partially-filled offer expires', async () => {
    const offerId = await createOffer({ expiryOffset: 120 });
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [121] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, market, 'finalizeOfferExpiry', [offerId]));
    assert.equal(await read(vault, 'availableBalance', [seller.account.address]), 66_666_667n);
    assert.equal((await read(vault, 'positionBucket', [1n])).amount, 33_333_333n);
  });

  it('starts a permissionless default auction and atomically settles collateral to a compliant bidder', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, market, 'startAuction', [1n]));
    const position = await read(market, 'getPosition', [1n]);
    const quote = await read(auction, 'currentPrice', [position.auctionId]);
    await receipt(publicClient, await write(bidder, market, 'buyAuction', [position.auctionId, quote]));
    assert.equal((await read(market, 'getPosition', [1n])).status, 4); // LIQUIDATED
    assert.equal(await read(asset, 'balanceOf', [bidder.account.address]), 33_333_333n);
    assert.equal(await read(vault, 'totalAccounted'), 66_666_667n);
  });

  it('keeps isolated closeout live when the oracle value rounds below one settlement unit', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await submitValuation(1n);
    await receipt(publicClient, await write(bidder, market, 'startAuction', [1n]));
    const position = await read(market, 'getPosition', [1n]);
    const liveAuction = await read(auction, 'getAuction', [position.auctionId]);
    assert.equal(liveAuction.floorPrice, 1n);
  });

  it('keeps failed-auction collateral safe until the compliant lender claims it', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, market, 'startAuction', [1n]));
    const position = await read(market, 'getPosition', [1n]);
    await provider.request({ method: 'evm_increaseTime', params: [61] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(bidder, market, 'finalizeFailedAuction', [position.auctionId]));
    await receipt(publicClient, await write(buyerA, market, 'claimDefaultCollateral', [1n, buyerA.account.address]));
    assert.equal((await read(market, 'getPosition', [1n])).status, 6); // COLLATERAL_CLAIMED
    assert.equal(await read(asset, 'balanceOf', [buyerA.account.address]), 33_333_333n);
  });

  it('allows bounded in-kind lender recovery only when the snapshotted oracle is unavailable', async () => {
    const offerId = await createOffer();
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    const latest = await read(oracle, 'latest', [asset.address]);
    await receipt(publicClient, await write(owner, oracle, 'invalidateValuation', [asset.address, latest.digest]));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 181] });
    await provider.request({ method: 'evm_mine', params: [] });
    await receipt(publicClient, await write(buyerA, market, 'claimCollateralOnOracleFailure', [1n, buyerA.account.address]));
    assert.equal((await read(market, 'getPosition', [1n])).status, 6);
    assert.equal(await read(asset, 'balanceOf', [buyerA.account.address]), 33_333_333n);
  });

  it('permits deterministic late cure after grace until an auction transaction wins ordering', async () => {
    const offerId = await createOffer({ earlyRepurchaseEnabled: false });
    await receipt(publicClient, await write(buyerA, market, 'fillOffer', [offerId, 2_000_000_000n, 3_000_000n]));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    const block = await publicClient.getBlock();
    const payoff = await read(market, 'previewPayoff', [1n, block.timestamp]);
    await receipt(publicClient, await write(seller, market, 'repurchase', [1n, payoff + 10_000n, false]));
    await expectRevert(publicClient, () => write(bidder, market, 'startAuction', [1n]));
  });
});
