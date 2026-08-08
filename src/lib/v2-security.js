import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex } from 'viem';
import { marginEngineV2Abi, repoMarketV2Abi, settlementEscrowV2Abi } from '../../packages/shared/src/v2-abis.ts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const isNonZeroAddress = (value) => ADDRESS_RE.test(value || '') && value.toLowerCase() !== ZERO_ADDRESS;
const sameAddress = (left, right) => Boolean(left && right) && left.toLowerCase() === right.toLowerCase();
const normalizeAddress = (value) => isNonZeroAddress(value) ? value.toLowerCase() : '';
const configuredContract = (manifest, key) => manifest?.contracts?.[key] || {};
const contractAddress = (manifest, key) => configuredContract(manifest, key).address || '';

function manifestProblems(manifest) {
  const problems = [];
  if (manifest?.schemaVersion !== 1 || manifest?.protocolVersion !== 'v2') problems.push('MANIFEST_SCHEMA_INVALID');
  if (manifest?.status !== 'ACTIVE') problems.push('MANIFEST_NOT_ACTIVE');
  if (Number(manifest?.chainId) !== 10_143) problems.push('MANIFEST_CHAIN_INVALID');
  for (const key of ['repoMarket', 'collateralVault', 'auctionHouse', 'settlementEscrow', 'valuationOracle', 'riskManager']) {
    const entry = configuredContract(manifest, key);
    if (!isNonZeroAddress(entry.address)) problems.push(`MANIFEST_${key.toUpperCase()}_MISSING`);
    if (!HASH_RE.test(entry.runtimeCodeHash || '')) problems.push(`MANIFEST_${key.toUpperCase()}_CODE_HASH_MISSING`);
  }
  const marginAddress = contractAddress(manifest, 'marginEngine');
  if (marginAddress) {
    for (const key of ['marginEngine', 'marginVault', 'marginAuctionHouse', 'marginSettlementEscrow']) {
      const entry = configuredContract(manifest, key);
      if (!isNonZeroAddress(entry.address)) problems.push(`MANIFEST_${key.toUpperCase()}_MISSING`);
      if (!HASH_RE.test(entry.runtimeCodeHash || '')) problems.push(`MANIFEST_${key.toUpperCase()}_CODE_HASH_MISSING`);
    }
    if (!isNonZeroAddress(manifest?.marginAsset?.address)) problems.push('MANIFEST_MARGIN_ASSET_MISSING');
    if (!HASH_RE.test(manifest?.marginAsset?.runtimeCodeHash || '')) problems.push('MANIFEST_MARGIN_ASSET_CODE_HASH_MISSING');
  }
  if (!isNonZeroAddress(manifest?.settlementToken?.address)) problems.push('MANIFEST_SETTLEMENT_TOKEN_MISSING');
  if (!HASH_RE.test(manifest?.settlementToken?.runtimeCodeHash || '')) problems.push('MANIFEST_SETTLEMENT_TOKEN_CODE_HASH_MISSING');
  if (!Array.isArray(manifest?.assets) || manifest.assets.length === 0) problems.push('MANIFEST_ASSETS_MISSING');
  for (const asset of manifest?.assets || []) {
    if (!isNonZeroAddress(asset.address) || !isNonZeroAddress(asset.vault)) problems.push('MANIFEST_ASSET_INVALID');
    if (!HASH_RE.test(asset.runtimeCodeHash || '')) problems.push('MANIFEST_ASSET_CODE_HASH_MISSING');
  }
  const contractAddresses = Object.values(manifest?.contracts || {})
    .map((entry) => normalizeAddress(entry?.address))
    .filter(Boolean);
  if (new Set(contractAddresses).size !== contractAddresses.length) problems.push('MANIFEST_CONTRACT_ADDRESS_COLLISION');
  if (sameAddress(manifest?.settlementToken?.address, manifest?.marginAsset?.address)) problems.push('MANIFEST_ASSET_COLLISION');
  return [...new Set(problems)];
}

export function compareApiConfigToManifest(apiConfig, manifest) {
  const errors = manifestProblems(manifest);
  if (errors.length) return { ok: false, errors };
  if (Number(apiConfig?.chainId) !== Number(manifest.chainId)) errors.push('API_CHAIN_MISMATCH');
  const apiContracts = apiConfig?.contracts || {};
  const marginProof = apiConfig?.readiness?.crossMargin?.proof || {};
  const identity = {
    repoMarket: apiContracts.repoMarketV2 || apiContracts.repoMarket || apiContracts.market,
    collateralVault: apiContracts.collateralVaultV2 || apiContracts.collateralVault || apiContracts.vault,
    auctionHouse: apiContracts.auctionHouse,
    settlementEscrow: apiContracts.settlementEscrow,
    marginEngine: apiContracts.marginEngine,
    marginVault: marginProof.vault,
    marginAuctionHouse: marginProof.auctionHouse,
    marginSettlementEscrow: marginProof.settlementEscrow,
    valuationOracle: apiContracts.valuationOracle,
    riskManager: apiContracts.riskManager,
  };
  for (const [key, entry] of Object.entries(manifest.contracts || {})) {
    if (isNonZeroAddress(entry?.address) && !sameAddress(identity[key], entry.address)) errors.push(`API_${key.toUpperCase()}_MISMATCH`);
  }
  if (!sameAddress(apiConfig?.settlementToken?.address, manifest.settlementToken.address)) errors.push('API_SETTLEMENT_TOKEN_MISMATCH');
  if (contractAddress(manifest, 'marginEngine') && !sameAddress(marginProof.asset, manifest.marginAsset.address)) {
    errors.push('API_MARGIN_ASSET_MISMATCH');
  }
  const apiAssets = new Map((apiConfig?.assets || []).map((asset) => [normalizeAddress(asset.address), asset]));
  const apiProofs = new Map((apiConfig?.readiness?.triPartyVault?.assetProofs || []).map((proof) => [normalizeAddress(proof.asset), proof]));
  for (const asset of manifest.assets || []) {
    const apiAsset = apiAssets.get(normalizeAddress(asset.address));
    const proof = apiProofs.get(normalizeAddress(asset.address));
    if (!apiAsset && !proof) errors.push(`API_ASSET_${normalizeAddress(asset.address)}_MISSING`);
    const apiVault = apiAsset?.vault || proof?.vault;
    if (!sameAddress(apiVault, asset.vault)) errors.push(`API_ASSET_${normalizeAddress(asset.address)}_VAULT_MISMATCH`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export async function verifyManifestRuntimeCode(manifest, readRuntimeCodeHash) {
  const errors = manifestProblems(manifest);
  const observed = {};
  if (errors.length) return { ok: false, errors, observed };
  const entries = [
    ...Object.entries(manifest.contracts || {}).map(([key, entry]) => ({ key: `contracts.${key}`, ...entry })),
    { key: 'settlementToken', ...manifest.settlementToken },
    { key: 'marginAsset', ...manifest.marginAsset },
    ...(manifest.assets || []).map((asset, index) => ({ key: `assets.${index}`, ...asset })),
  ].filter((entry) => isNonZeroAddress(entry.address) && HASH_RE.test(entry.runtimeCodeHash || ''));
  for (const entry of entries) {
    try {
      const actual = await readRuntimeCodeHash(entry.address);
      observed[entry.key] = actual;
      if (!HASH_RE.test(actual || '') || actual.toLowerCase() !== entry.runtimeCodeHash.toLowerCase()) {
        errors.push(`CODE_HASH_MISMATCH:${entry.key}`);
      }
    } catch {
      errors.push(`CODE_UNAVAILABLE:${entry.key}`);
    }
  }
  return { ok: errors.length === 0, errors, observed };
}

export function pinTrustedV2Config(apiConfig, manifest, runtimeVerification) {
  const identity = compareApiConfigToManifest(apiConfig, manifest);
  if (!identity.ok || runtimeVerification?.ok !== true) {
    const error = new Error(`The V2 deployment does not match the reviewed browser manifest: ${[...identity.errors, ...(runtimeVerification?.errors || [])].join(', ')}`);
    error.code = 'UNTRUSTED_V2_DEPLOYMENT';
    throw error;
  }
  const trustedAssets = new Map((manifest.assets || []).map((asset) => [normalizeAddress(asset.address), asset]));
  const apiAssets = new Map((apiConfig?.assets || []).map((asset) => [normalizeAddress(asset.address), asset]));
  const assets = [...trustedAssets.values()].map((asset) => ({
    ...asset,
    ...(apiAssets.get(normalizeAddress(asset.address)) || {}),
    address: asset.address,
    vault: asset.vault,
    decimals: Number(asset.decimals),
  }));
  if (isNonZeroAddress(manifest.marginAsset?.address) && !assets.some((asset) => sameAddress(asset.address, manifest.marginAsset.address))) {
    const dynamic = apiAssets.get(normalizeAddress(manifest.marginAsset.address)) || {};
    assets.push({ ...manifest.marginAsset, ...dynamic, address: manifest.marginAsset.address, decimals: Number(manifest.marginAsset.decimals) });
  }
  const apiProofs = new Map((apiConfig?.readiness?.triPartyVault?.assetProofs || []).map((proof) => [normalizeAddress(proof.asset), proof]));
  const assetProofs = [...trustedAssets.values()].map((asset) => ({
    ...(apiProofs.get(normalizeAddress(asset.address)) || {}),
    asset: asset.address,
    vault: asset.vault,
  }));
  const marginConfigured = isNonZeroAddress(contractAddress(manifest, 'marginEngine'));
  const marginProof = apiConfig?.readiness?.crossMargin?.proof || {};
  return {
    ...apiConfig,
    chainId: manifest.chainId,
    contracts: {
      ...apiConfig.contracts,
      repoMarket: contractAddress(manifest, 'repoMarket'),
      collateralVault: contractAddress(manifest, 'collateralVault'),
      auctionHouse: contractAddress(manifest, 'auctionHouse'),
      settlementEscrow: contractAddress(manifest, 'settlementEscrow'),
      marginEngine: contractAddress(manifest, 'marginEngine') || null,
      valuationOracle: contractAddress(manifest, 'valuationOracle'),
      riskManager: contractAddress(manifest, 'riskManager'),
    },
    settlementToken: { ...manifest.settlementToken },
    assets,
    readiness: {
      ...apiConfig.readiness,
      triPartyVault: { ...apiConfig.readiness?.triPartyVault, assetProofs },
      crossMargin: {
        ...apiConfig.readiness?.crossMargin,
        proof: marginConfigured ? {
          ...marginProof,
          configured: true,
          asset: manifest.marginAsset.address,
          vault: contractAddress(manifest, 'marginVault'),
          auctionHouse: contractAddress(manifest, 'marginAuctionHouse'),
          settlementEscrow: contractAddress(manifest, 'marginSettlementEscrow'),
          settlementToken: manifest.settlementToken.address,
        } : null,
      },
    },
    deploymentTrust: {
      verified: true,
      deploymentId: manifest.deploymentId,
      runtimeCodeVerified: true,
    },
  };
}

function vaultForAsset(config, address) {
  const asset = (config?.assets || []).find((row) => sameAddress(row.address, address));
  const proof = (config?.readiness?.triPartyVault?.assetProofs || []).find((row) => sameAddress(row.asset, address));
  return asset?.vault || proof?.vault || '';
}

function approval(token, spender, amount) {
  if (!isNonZeroAddress(token) || !isNonZeroAddress(spender)) throw new Error('The trusted approval target is unavailable.');
  const normalizedAmount = BigInt(amount ?? 0).toString();
  if (BigInt(normalizedAmount) <= 0n) return [];
  return [{ token: token.toLowerCase(), spender: spender.toLowerCase(), amount: normalizedAmount }];
}

export function expectedApprovalTuples(kind, body, result, trustedConfig) {
  const contracts = trustedConfig?.contracts || {};
  const market = contracts.repoMarketV2 || contracts.repoMarket || contracts.market;
  const settlement = trustedConfig?.settlementToken?.address;
  if (kind === 'deposit') return approval(body.asset, vaultForAsset(trustedConfig, body.asset), body.amount);
  if (kind === 'create-offer') {
    const deficit = result?.quote?.amounts?.depositDeficit || '0';
    return BigInt(deficit) > 0n ? approval(body.asset, vaultForAsset(trustedConfig, body.asset), deficit) : [];
  }
  if (kind === 'fill') return approval(settlement, market, body.principalAmount);
  if (kind === 'repay') return approval(settlement, market, result?.quote?.amounts?.payoff);
  if (kind === 'buy-auction') return approval(settlement, market, result?.quote?.amounts?.currentPrice);
  if (kind !== 'margin-action') return [];
  const action = ({ DEPOSIT_COLLATERAL: 'DEPOSIT', WITHDRAW_AVAILABLE: 'WITHDRAW', REPAY_EXPOSURE: 'REPAY', CURE_MARGIN_CALL: 'CURE', START_LIQUIDATION: 'LIQUIDATE' })[body.action] || body.action;
  const proof = trustedConfig?.readiness?.crossMargin?.proof || {};
  if (action === 'DEPOSIT') return approval(proof.asset, proof.vault, body.amount);
  if (action === 'FUND_ACCOUNT') return approval(settlement, contracts.marginEngine, body.amount);
  if (action === 'REPAY') return approval(settlement, contracts.marginEngine, result?.quote?.amounts?.faceDebt);
  if (action === 'BUY_AUCTION') return approval(settlement, contracts.marginEngine, result?.quote?.amounts?.currentPrice);
  return [];
}

export function validateApprovalInstructions(kind, body, result, trustedConfig) {
  const expected = expectedApprovalTuples(kind, body, result, trustedConfig);
  const actual = result?.requiredApprovals || result?.approvals || [];
  if (actual.length > expected.length) throw new Error(`Preflight returned an unexpected approval for ${kind}.`);
  const unused = [...expected];
  for (const instruction of actual) {
    let amount;
    try { amount = BigInt(instruction.amount).toString(); } catch { throw new Error('Preflight returned a malformed approval amount.'); }
    const index = unused.findIndex((item) => sameAddress(item.token, instruction.token || instruction.asset)
      && sameAddress(item.spender, instruction.spender)
      && item.amount === amount);
    if (index < 0) throw new Error(`Preflight returned an approval that does not exactly match the reviewed ${kind} transfer.`);
    unused.splice(index, 1);
  }
  return actual;
}

const selector = (signature) => keccak256(stringToHex(signature)).slice(0, 10).toLowerCase();
const V2_ACTION_SELECTORS = Object.freeze({
  deposit: [selector('depositCollateral(address,uint256)')],
  withdraw: [selector('withdrawCollateral(address,uint256,address)')],
  'create-offer': [selector('depositCollateral(address,uint256)'), selector('createOffer((address,uint128,uint128,uint128,uint32,uint64,uint64,address,bool))')],
  fill: [selector('fillOffer(uint256,uint256,uint256)')],
  repay: [selector('repurchase(uint256,uint256,bool)')],
  'cancel-offer': [selector('cancelOffer(uint256)')],
  'finalize-offer-expiry': [selector('finalizeOfferExpiry(uint256)')],
  'start-auction': [selector('startAuction(uint256)')],
  'buy-auction': [selector('buyAuction(uint256,uint256)')],
  'finalize-failed-auction': [selector('finalizeFailedAuction(uint256)')],
  'claim-collateral': [selector('claimDefaultCollateral(uint256,address)')],
  'claim-oracle-fallback': [selector('claimCollateralOnOracleFailure(uint256,address)')],
  'claim-settlement': [selector('claim(uint256,uint256,address)')],
  'margin-action': [
    selector('depositCollateral(uint256)'), selector('withdrawAvailable(uint256,address)'), selector('openMarginAccount((uint128,uint128,uint128,uint32,uint64,uint64,address))'),
    selector('addMarginCollateral(uint256,uint128)'), selector('withdrawExcessCollateral(uint256,uint128,address)'),
    selector('fundMarginAccount(uint256,uint128,uint32,uint256)'), selector('closeFunding(uint256)'), selector('repayExposure(uint256,uint256,bool)'),
    selector('declarePaymentDefault(uint256)'), selector('openMarginCall(uint256)'), selector('cureMarginCall(uint256)'),
    selector('startMarginLiquidation(uint256)'), selector('buyMarginAuction(uint256,uint256)'),
    selector('finalizeFailedMarginAuction(uint256)'), selector('startInKindOracleFallback(uint256)'),
    selector('materializeLiquidationClaim(uint256)'), selector('claimFailedCollateral(uint256,address)'), selector('closeMarginAccount(uint256)'),
  ],
});

export function assertV2Instruction(kind, transaction, trustedConfig, body, result, index, total) {
  const contracts = trustedConfig?.contracts || {};
  const allowedEscrows = [contracts.settlementEscrow, trustedConfig?.readiness?.crossMargin?.proof?.settlementEscrow]
    .filter(isNonZeroAddress).map((value) => value.toLowerCase());
  const expectedDestination = kind === 'claim-settlement' ? body.escrowAddress
    : kind === 'margin-action' ? contracts.marginEngine
      : contracts.repoMarketV2 || contracts.repoMarket || contracts.market;
  if (kind === 'claim-settlement' && !allowedEscrows.includes(body.escrowAddress?.toLowerCase())) throw new Error('The claim escrow is not in the trusted V2 deployment manifest.');
  if (!expectedDestination || transaction.to?.toLowerCase() !== expectedDestination.toLowerCase()) throw new Error(`Preflight returned an unexpected ${kind} transaction destination.`);
  if (BigInt(transaction.value || 0) !== 0n) throw new Error('RWCAR V2 actions never require a native MON transfer.');
  const data = transaction.data || transaction.calldata || '';
  const allowedSelectors = V2_ACTION_SELECTORS[kind] || [];
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data) || !allowedSelectors.includes(data.slice(0, 10).toLowerCase())) throw new Error(`Preflight returned unexpected calldata for ${kind}.`);
  const abi = kind === 'claim-settlement' ? settlementEscrowV2Abi : kind === 'margin-action' ? marginEngineV2Abi : repoMarketV2Abi;
  let decoded;
  try { decoded = decodeFunctionData({ abi, data }); } catch { throw new Error(`Preflight returned malformed calldata for ${kind}.`); }
  if (encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== data.toLowerCase()) throw new Error(`Preflight returned non-canonical calldata for ${kind}.`);
  const args = decoded.args || [];
  const sameUint = (actual, expected) => expected !== undefined && expected !== null && BigInt(actual) === BigInt(expected);
  const fail = () => { throw new Error(`Preflight calldata does not match the reviewed ${kind} request.`); };
  const createNeedsDeposit = BigInt(result?.quote?.amounts?.depositDeficit || 0) > 0n;
  const expectedFunctions = {
    deposit: ['depositCollateral'], withdraw: ['withdrawCollateral'], 'create-offer': createNeedsDeposit ? ['depositCollateral', 'createOffer'] : ['createOffer'],
    fill: ['fillOffer'], repay: ['repurchase'], 'cancel-offer': ['cancelOffer'], 'finalize-offer-expiry': ['finalizeOfferExpiry'],
    'start-auction': ['startAuction'], 'buy-auction': ['buyAuction'], 'finalize-failed-auction': ['finalizeFailedAuction'],
    'claim-collateral': ['claimDefaultCollateral'], 'claim-oracle-fallback': ['claimCollateralOnOracleFailure'], 'claim-settlement': ['claim'],
  }[kind];
  if (expectedFunctions && (total !== expectedFunctions.length || decoded.functionName !== expectedFunctions[index])) fail();
  if (!expectedFunctions && kind !== 'margin-action') fail();
  const normalizedMarginAction = kind === 'margin-action' ? ({ DEPOSIT_COLLATERAL: 'DEPOSIT', WITHDRAW_AVAILABLE: 'WITHDRAW', REPAY_EXPOSURE: 'REPAY', CURE_MARGIN_CALL: 'CURE', START_LIQUIDATION: 'LIQUIDATE' }[body.action] || body.action) : null;
  const marginFunction = normalizedMarginAction ? ({
    DEPOSIT: 'depositCollateral', WITHDRAW: 'withdrawAvailable', OPEN_ACCOUNT: 'openMarginAccount', ADD_COLLATERAL: 'addMarginCollateral',
    WITHDRAW_EXCESS: 'withdrawExcessCollateral', FUND_ACCOUNT: 'fundMarginAccount', CLOSE_FUNDING: 'closeFunding', REPAY: 'repayExposure',
    DECLARE_PAYMENT_DEFAULT: 'declarePaymentDefault', OPEN_MARGIN_CALL: 'openMarginCall', CURE: 'cureMarginCall',
    LIQUIDATE: 'startMarginLiquidation', BUY_AUCTION: 'buyMarginAuction', FINALIZE_FAILED_AUCTION: 'finalizeFailedMarginAuction',
    START_IN_KIND_ORACLE_FALLBACK: 'startInKindOracleFallback', MATERIALIZE_LIQUIDATION_CLAIM: 'materializeLiquidationClaim',
    CLAIM_FAILED_COLLATERAL: 'claimFailedCollateral', CLOSE_ACCOUNT: 'closeMarginAccount',
  }[normalizedMarginAction]) : null;
  if (kind === 'margin-action' && (!marginFunction || total !== 1 || decoded.functionName !== marginFunction)) fail();
  switch (decoded.functionName) {
    case 'depositCollateral': {
      if (kind === 'margin-action') { if (!sameUint(args[0], body.amount)) fail(); break; }
      const expectedAmount = kind === 'create-offer' ? result?.quote?.amounts?.depositDeficit : body.amount;
      if (!sameAddress(args[0], body.asset) || !sameUint(args[1], expectedAmount)) fail();
      if (kind === 'create-offer' && index !== 0) fail();
      break;
    }
    case 'withdrawCollateral': if (!sameAddress(args[0], body.asset) || !sameUint(args[1], body.amount) || !sameAddress(args[2], body.recipient || body.actor)) fail(); break;
    case 'createOffer': {
      const params = args[0];
      if (index !== total - 1 || !sameAddress(params.asset, body.asset) || !sameUint(params.collateralAmount, body.totalCollateral)
        || !sameUint(params.targetPrincipal, body.targetPrincipal) || !sameUint(params.minimumFill, body.minimumFill)
        || !sameUint(params.annualRateBps, body.annualRateBps) || !sameUint(params.duration, body.durationSeconds)
        || !sameUint(params.offerExpiry, body.offerExpiry) || !sameAddress(params.permittedBuyer, body.permittedBuyer || ZERO_ADDRESS)
        || params.earlyRepurchaseEnabled !== body.earlyRepurchaseEnabled) fail();
      break;
    }
    case 'fillOffer': if (!sameUint(args[0], body.offerId) || !sameUint(args[1], body.principalAmount) || !sameUint(args[2], result?.quote?.amounts?.openingFee)) fail(); break;
    case 'repurchase': if (!sameUint(args[0], body.positionId) || !sameUint(args[1], body.maxPayoff) || args[2] !== Boolean(result?.quote?.projectedState?.useEscrow)) fail(); break;
    case 'cancelOffer': case 'finalizeOfferExpiry': if (!sameUint(args[0], body.offerId)) fail(); break;
    case 'startAuction': case 'claimDefaultCollateral': case 'claimCollateralOnOracleFailure':
      if (!sameUint(args[0], body.positionId) || (args.length > 1 && !sameAddress(args[1], body.recipient || body.actor))) fail(); break;
    case 'buyAuction': if (!sameUint(args[0], body.auctionId) || !sameUint(args[1], body.maxPrice)) fail(); break;
    case 'finalizeFailedAuction': if (!sameUint(args[0], body.auctionId)) fail(); break;
    case 'claim': if (!sameUint(args[0], body.claimId) || !sameUint(args[1], body.amount) || !sameAddress(args[2], body.recipient || body.actor)) fail(); break;
    case 'withdrawAvailable': if (!sameUint(args[0], body.amount) || !sameAddress(args[1], body.recipient || body.actor)) fail(); break;
    case 'openMarginAccount': {
      const params = args[0];
      if (!sameUint(params.collateralAmount, body.amount)
        || !sameUint(params.fundingTarget, body.fundingTarget)
        || !sameUint(params.minimumFunding, body.minimumFunding)
        || !sameUint(params.maxAnnualRateBps, body.maxAnnualRateBps)
        || !sameUint(params.duration, body.durationSeconds)
        || !sameUint(params.fundingExpiry, body.fundingExpiry)
        || !sameAddress(params.permittedLender, body.permittedLender || ZERO_ADDRESS)) fail();
      break;
    }
    case 'addMarginCollateral': if (!sameUint(args[0], body.accountId) || !sameUint(args[1], body.amount)) fail(); break;
    case 'withdrawExcessCollateral': if (!sameUint(args[0], body.accountId) || !sameUint(args[1], body.amount) || !sameAddress(args[2], body.recipient || body.actor)) fail(); break;
    case 'fundMarginAccount':
      if (!sameUint(args[0], body.accountId) || !sameUint(args[1], body.amount) || !sameUint(args[2], body.annualRateBps)
        || !sameUint(args[3], body.maxFee ?? result?.quote?.amounts?.openingFee)) fail(); break;
    case 'repayExposure':
      if (!sameUint(args[0], body.exposureId) || !sameUint(args[1], body.maxFaceDebt ?? result?.quote?.amounts?.faceDebt)
        || args[2] !== Boolean(body.useEscrow ?? result?.quote?.projectedState?.useEscrow)) fail(); break;
    case 'declarePaymentDefault': case 'materializeLiquidationClaim': if (!sameUint(args[0], body.exposureId)) fail(); break;
    case 'closeFunding': case 'openMarginCall': case 'cureMarginCall': case 'startMarginLiquidation': case 'startInKindOracleFallback': case 'closeMarginAccount':
      if (!sameUint(args[0], body.accountId)) fail(); break;
    case 'buyMarginAuction': if (!sameUint(args[0], body.auctionId) || !sameUint(args[1], body.maxPrice ?? result?.quote?.amounts?.maxPrice)) fail(); break;
    case 'finalizeFailedMarginAuction': if (!sameUint(args[0], body.auctionId)) fail(); break;
    case 'claimFailedCollateral': if (!sameUint(args[0], body.exposureId) || !sameAddress(args[1], body.recipient || body.actor)) fail(); break;
    default: if (kind !== 'margin-action') fail();
  }
}
