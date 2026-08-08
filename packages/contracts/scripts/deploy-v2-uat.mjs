import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  keccak256,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 10_143;
const EXECUTION_CONFIRMATION = 'DEPLOY_RWCAR_V2_TO_MONAD_TESTNET_10143';
const KEY_ATTESTATION = 'FRESH_UAT_KEYS_NOT_PREVIOUSLY_SHARED';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const optional = (name, fallback) => process.env[name]?.trim() || fallback;

const address = (name) => {
  const value = required(name);
  if (!isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return value;
};

const integer = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = optional(name, String(fallback));
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
};

const boolean = (name, fallback = false) => {
  const raw = optional(name, String(fallback)).toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
};

const bytes32 = (name) => {
  const value = required(name);
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${name} must be bytes32`);
  if (/^0x0{64}$/.test(value)) throw new Error(`${name} must not be zero`);
  return value;
};

const artifact = (name) => {
  const compiled = JSON.parse(readFileSync(join(packageRoot, 'artifacts-solc', `${name}.json`), 'utf8'));
  if (!compiled.bytecode || compiled.bytecode === '0x' || !compiled.deployedBytecode) {
    throw new Error(`Artifact ${name} is missing deployable bytecode; run the production build first`);
  }
  return compiled;
};

const artifacts = Object.fromEntries([
  'CvaAssetRegistry',
  'ProtocolModuleFactoryV2',
  'RiskManagerV2',
  'SignedValuationOracle',
  'RepoMarketV2',
  'MarginEngineV2',
  'CollateralVaultV2',
  'DutchAuctionV2',
  'SettlementEscrowV2',
].map((name) => [name, artifact(name)]));

const mode = optional('V2_DEPLOY_MODE', 'plan').toLowerCase();
if (mode !== 'plan' && mode !== 'execute') throw new Error('V2_DEPLOY_MODE must be plan or execute');
const sourceRevision = optional('V2_SOURCE_REVISION', 'RECORD_BEFORE_EXECUTION');
if (mode === 'execute' && sourceRevision === 'RECORD_BEFORE_EXECUTION') {
  throw new Error('V2_SOURCE_REVISION is required for execution');
}

const deployer = address('V2_DEPLOYER_ADDRESS');
const owner = address('V2_OWNER_ADDRESS');
const factoryActivationOwner = address('V2_FACTORY_ACTIVATION_OWNER');
const pauseGuardian = address('V2_PAUSE_GUARDIAN_ADDRESS');
const feeTreasury = address('FEE_TREASURY_ADDRESS');
const cvaAsset = address('CVA_ASSET_ADDRESS');
const settlementToken = address('V2_SETTLEMENT_TOKEN_ADDRESS');
const complianceValidator = address('COMPLIANCE_VALIDATOR_ADDRESS');
const referenceHash = bytes32('CVA_REFERENCE_HASH');
const oracleSigners = [1, 2, 3].map((index) => address(`V2_ORACLE_SIGNER_${index}`));
const allowRoleOverlap = boolean('V2_ALLOW_ROLE_OVERLAP', false);
const allowEoaOwner = boolean('V2_ALLOW_EOA_OWNER', false);

const allowedDurations = required('V2_ALLOWED_DURATIONS').split(',').map((raw) => {
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0 || value > 365 * 24 * 60 * 60) {
    throw new Error(`Invalid duration in V2_ALLOWED_DURATIONS: ${raw}`);
  }
  return value;
});
if (new Set(allowedDurations).size !== allowedDurations.length) {
  throw new Error('V2_ALLOWED_DURATIONS must not contain duplicates');
}

const protocolFeeBps = integer('V2_PROTOCOL_FEE_BPS', 15, { max: 9_999 });
const gracePeriod = integer('V2_GRACE_PERIOD_SECONDS', 120, { min: 1, max: 30 * 24 * 60 * 60 });
const riskConfigDelay = integer('V2_RISK_CONFIG_DELAY_SECONDS', 86_400, {
  min: 3_600,
  max: 30 * 24 * 60 * 60,
});
const cvaDecimals = integer('CVA_ASSET_DECIMALS', 6, { max: 18 });
const confirmations = integer('V2_DEPLOY_CONFIRMATIONS', 3, { min: 2, max: 20 });

const riskConfig = {
  enabled: true,
  initialLtvBps: integer('V2_INITIAL_LTV_BPS', 7_000, { min: 1, max: 9_999 }),
  maintenanceLtvBps: integer('V2_MAINTENANCE_LTV_BPS', 8_000, { min: 1, max: 9_999 }),
  liquidationLtvBps: integer('V2_LIQUIDATION_LTV_BPS', 8_500, { min: 1, max: 10_000 }),
  auctionStartBps: integer('V2_AUCTION_START_BPS', 10_500, { min: 10_000, max: 65_535 }),
  auctionFloorBps: integer('V2_AUCTION_FLOOR_BPS', 8_000, { min: 1, max: 65_535 }),
  liquidationFeeBps: integer('V2_LIQUIDATION_FEE_BPS', 50, { max: 9_999 }),
  earlyMinHoldBps: integer('V2_EARLY_MIN_HOLD_BPS', 1_000, { max: 10_000 }),
  earlyBreakFeeBps: integer('V2_EARLY_BREAK_FEE_BPS', 25, { max: 9_999 }),
  defaultSpreadBps: integer('V2_DEFAULT_SPREAD_BPS', 500, { max: 100_000 }),
  maxDefaultRateBps: integer('V2_MAX_DEFAULT_RATE_BPS', 5_000, { max: 100_000 }),
  maxOracleAge: integer('V2_MAX_ORACLE_AGE_SECONDS', 3_600, { min: 1, max: 30 * 24 * 60 * 60 }),
  auctionDuration: integer('V2_AUCTION_DURATION_SECONDS', 1_800, { min: 1, max: 30 * 24 * 60 * 60 }),
  marginCallPeriod: integer('V2_MARGIN_CALL_PERIOD_SECONDS', 3_600, { min: 1, max: 30 * 24 * 60 * 60 }),
  staleOracleFallbackDelay: integer('V2_STALE_ORACLE_FALLBACK_DELAY_SECONDS', 86_400, {
    min: 1,
    max: 30 * 24 * 60 * 60,
  }),
};

if (!(riskConfig.initialLtvBps < riskConfig.maintenanceLtvBps
  && riskConfig.maintenanceLtvBps < riskConfig.liquidationLtvBps)) {
  throw new Error('LTV thresholds must satisfy initial < maintenance < liquidation');
}
if (riskConfig.auctionFloorBps > riskConfig.auctionStartBps) {
  throw new Error('V2_AUCTION_FLOOR_BPS cannot exceed V2_AUCTION_START_BPS');
}
if (riskConfig.maxDefaultRateBps < riskConfig.defaultSpreadBps) {
  throw new Error('V2_MAX_DEFAULT_RATE_BPS cannot be below V2_DEFAULT_SPREAD_BPS');
}

const distinctOracleSigners = new Set(oracleSigners.map((value) => value.toLowerCase()));
if (distinctOracleSigners.size !== 3) throw new Error('The three oracle signers must be distinct');
if (owner.toLowerCase() === deployer.toLowerCase()) {
  throw new Error('V2_OWNER_ADDRESS must be separate from the one-time deployer');
}
if (!allowRoleOverlap) {
  const criticalRoles = [deployer, owner, factoryActivationOwner, pauseGuardian, feeTreasury, ...oracleSigners]
    .map((value) => value.toLowerCase());
  if (new Set(criticalRoles).size !== criticalRoles.length) {
    throw new Error('Critical roles must be distinct unless V2_ALLOW_ROLE_OVERLAP=true is explicitly set');
  }
}
if (cvaAsset.toLowerCase() === settlementToken.toLowerCase()) {
  throw new Error('Collateral CVA and settlement token must be different assets');
}

const artifactManifest = Object.fromEntries(Object.entries(artifacts).map(([name, compiled]) => [name, {
  sourceName: compiled.sourceName,
  initCodeHash: keccak256(compiled.bytecode),
  compiledRuntimeTemplateHash: keccak256(compiled.deployedBytecode),
  initCodeBytes: (compiled.bytecode.length - 2) / 2,
  runtimeCodeBytes: (compiled.deployedBytecode.length - 2) / 2,
}]));

const baseManifest = {
  schemaVersion: 1,
  protocolVersion: 'v2',
  status: mode === 'execute' ? 'DEPLOYING_NOT_ACTIVE' : 'PLANNED_NOT_ACTIVE',
  network: { name: 'Monad Testnet', chainId: CHAIN_ID, rpcUrlRecordedSeparately: true },
  generatedAt: new Date().toISOString(),
  release: {
    sourceRevision,
    compiler: 'solc 0.8.24; optimizer 500 runs; viaIR true',
    artifacts: artifactManifest,
  },
  roles: { deployer, pendingOwner: owner, factoryActivationOwner, pauseGuardian, feeTreasury, oracleSigners },
  externalContracts: { cvaAsset, settlementToken, complianceValidator, cvaReferenceHash: referenceHash },
  parameters: {
    cvaDecimals,
    protocolFeeBps,
    gracePeriod,
    allowedDurations,
    riskConfigDelay,
    riskConfig,
  },
  safety: {
    deployerIsOneTime: true,
    entryPausedAtHandoff: true,
    cleanverseReadinessAtHandoff: false,
    ownerContractRequired: !allowEoaOwner,
    factoryActivationOwnerMustBeEoa: true,
    executeRequiresConfirmation: EXECUTION_CONFIRMATION,
  },
};

if (mode === 'plan') {
  console.log(JSON.stringify({
    ...baseManifest,
    contracts: {
      assetRegistry: null,
      moduleFactory: null,
      riskManager: null,
      valuationOracle: null,
      repoMarket: null,
      marketVault: null,
      marketAuction: null,
      marketSettlementEscrow: null,
      marginEngine: null,
      marginVault: null,
      marginAuction: null,
      marginSettlementEscrow: null,
    },
    requiredNextSteps: [
      'Review this plan, compiled artifact hashes, role separation, and risk parameters.',
      'Set V2_DEPLOY_MODE=execute only in a one-time deployment shell.',
      `Set V2_DEPLOY_CONFIRM=${EXECUTION_CONFIRMATION} and provide a fresh deployer key only at execution.`,
      'Capture the execution manifest; deployment does not activate custody or entry.',
    ],
  }, null, 2));
  process.exit(0);
}

if (required('V2_DEPLOY_CONFIRM') !== EXECUTION_CONFIRMATION) {
  throw new Error(`V2_DEPLOY_CONFIRM must equal ${EXECUTION_CONFIRMATION}`);
}
if (required('V2_KEY_ROTATION_ATTESTATION') !== KEY_ATTESTATION) {
  throw new Error(`V2_KEY_ROTATION_ATTESTATION must equal ${KEY_ATTESTATION}`);
}

const account = privateKeyToAccount(required('V2_UAT_DEPLOYER_PRIVATE_KEY'));
if (account.address.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error('V2_UAT_DEPLOYER_PRIVATE_KEY does not match V2_DEPLOYER_ADDRESS');
}

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [optional('MONAD_RPC_URL', 'https://testnet-rpc.monad.xyz')] } },
});
const transport = http(chain.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 3 });
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const transactionRecords = {};

const assertCode = async (label, target) => {
  const code = await publicClient.getBytecode({ address: target });
  if (!code || code === '0x') throw new Error(`${label} has no contract code at ${target}`);
};

const deploy = async (key, contractName, args) => {
  const compiled = artifacts[contractName];
  const hash = await walletClient.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args });
  console.error(JSON.stringify({ stage: key, txHash: hash, state: 'SUBMITTED' }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${contractName} deployment failed: ${hash}`);
  }
  const deployedCode = await publicClient.getBytecode({ address: receipt.contractAddress });
  if (!deployedCode || deployedCode === '0x') throw new Error(`${contractName} has no code after deployment`);
  const deployedCodeBytes = (deployedCode.length - 2) / 2;
  const expectedCodeBytes = (compiled.deployedBytecode.length - 2) / 2;
  if (deployedCodeBytes !== expectedCodeBytes) {
    throw new Error(`${contractName} runtime size mismatch: deployed ${deployedCodeBytes}, compiled ${expectedCodeBytes}`);
  }
  transactionRecords[key] = {
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    contractAddress: receipt.contractAddress,
    deployedRuntimeCodeHash: keccak256(deployedCode),
    deployedRuntimeCodeBytes: deployedCodeBytes,
  };
  return { address: receipt.contractAddress, blockNumber: receipt.blockNumber, abi: compiled.abi };
};

const write = async (key, contract, functionName, args) => {
  const simulation = await publicClient.simulateContract({
    account,
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const hash = await walletClient.writeContract(simulation.request);
  console.error(JSON.stringify({ stage: key, txHash: hash, state: 'SUBMITTED' }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
  if (receipt.status !== 'success') throw new Error(`${functionName} failed: ${hash}`);
  transactionRecords[key] = { txHash: hash, blockNumber: receipt.blockNumber.toString() };
  return receipt;
};

const liveChainId = await publicClient.getChainId();
if (liveChainId !== CHAIN_ID) throw new Error(`RPC returned chain ${liveChainId}; expected ${CHAIN_ID}`);
await Promise.all([
  assertCode('CVA asset', cvaAsset),
  assertCode('Settlement token', settlementToken),
  assertCode('Compliance validator', complianceValidator),
]);
const erc20MetadataAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);
const [liveCvaDecimals, liveSettlementDecimals, liveCvaName, liveCvaSymbol, liveSettlementName, liveSettlementSymbol, cvaRuntime, settlementRuntime, ownerCode, factoryActivationOwnerCode] = await Promise.all([
  publicClient.readContract({ address: cvaAsset, abi: erc20MetadataAbi, functionName: 'decimals' }),
  publicClient.readContract({ address: settlementToken, abi: erc20MetadataAbi, functionName: 'decimals' }),
  publicClient.readContract({ address: cvaAsset, abi: erc20MetadataAbi, functionName: 'name' }),
  publicClient.readContract({ address: cvaAsset, abi: erc20MetadataAbi, functionName: 'symbol' }),
  publicClient.readContract({ address: settlementToken, abi: erc20MetadataAbi, functionName: 'name' }),
  publicClient.readContract({ address: settlementToken, abi: erc20MetadataAbi, functionName: 'symbol' }),
  publicClient.getBytecode({ address: cvaAsset }),
  publicClient.getBytecode({ address: settlementToken }),
  publicClient.getBytecode({ address: owner }),
  publicClient.getBytecode({ address: factoryActivationOwner }),
]);
if (Number(liveCvaDecimals) !== cvaDecimals) {
  throw new Error(`CVA decimals mismatch: configured ${cvaDecimals}, on-chain ${liveCvaDecimals}`);
}
if (Number(liveSettlementDecimals) > 18) throw new Error('Settlement token decimals exceed protocol limit');
if (!cvaRuntime || cvaRuntime === '0x' || !settlementRuntime || settlementRuntime === '0x') {
  throw new Error('External CVA or settlement token runtime code became unavailable');
}
if ((!ownerCode || ownerCode === '0x') && !allowEoaOwner) {
  throw new Error('V2_OWNER_ADDRESS has no code; use a deployed multisig/timelock or explicitly allow an EOA for UAT');
}
if (factoryActivationOwnerCode && factoryActivationOwnerCode !== '0x') {
  throw new Error('V2_FACTORY_ACTIVATION_OWNER must be an EOA able to produce the Cleanverse personal_sign proof');
}
if (await publicClient.getBalance({ address: deployer }) === 0n) throw new Error('Deployer has no MON for gas');

// Cleanverse currently verifies an EIP-191 signature against factory.owner(), so
// a fresh activation EOA owns only this constrained factory during registration.
// It must hand ownership to the reviewed final owner after every custody proof.
const moduleFactory = await deploy('deployModuleFactory', 'ProtocolModuleFactoryV2', [factoryActivationOwner, complianceValidator]);
const assetRegistry = await deploy('deployAssetRegistry', 'CvaAssetRegistry', [deployer]);
const riskManager = await deploy('deployRiskManager', 'RiskManagerV2', [deployer, riskConfigDelay]);
const valuationOracle = await deploy('deployValuationOracle', 'SignedValuationOracle', [deployer, oracleSigners]);

await write('enableCvaAsset', assetRegistry, 'setAsset', [cvaAsset, true, cvaDecimals, referenceHash]);
const repoMarket = await deploy('deployRepoMarket', 'RepoMarketV2', [
  deployer,
  settlementToken,
  complianceValidator,
  assetRegistry.address,
  valuationOracle.address,
  riskManager.address,
  moduleFactory.address,
  feeTreasury,
  protocolFeeBps,
  gracePeriod,
  allowedDurations,
]);
const configureAssetReceipt = await write('configureMarketAsset', repoMarket, 'configureAsset', [cvaAsset]);
const marginEngine = await deploy('deployMarginEngine', 'MarginEngineV2', [
  deployer,
  settlementToken,
  cvaAsset,
  complianceValidator,
  assetRegistry.address,
  valuationOracle.address,
  riskManager.address,
  moduleFactory.address,
  feeTreasury,
  protocolFeeBps,
  gracePeriod,
  allowedDurations,
]);

const [marketAssetConfig, marketAuction, marketEscrow, marginVault, marginAuction, marginEscrow] = await Promise.all([
  publicClient.readContract({ address: repoMarket.address, abi: repoMarket.abi, functionName: 'getAssetConfig', args: [cvaAsset] }),
  publicClient.readContract({ address: repoMarket.address, abi: repoMarket.abi, functionName: 'auctionHouse' }),
  publicClient.readContract({ address: repoMarket.address, abi: repoMarket.abi, functionName: 'settlementEscrow' }),
  publicClient.readContract({ address: marginEngine.address, abi: marginEngine.abi, functionName: 'vault' }),
  publicClient.readContract({ address: marginEngine.address, abi: marginEngine.abi, functionName: 'auctionHouse' }),
  publicClient.readContract({ address: marginEngine.address, abi: marginEngine.abi, functionName: 'settlementEscrow' }),
]);
const marketVault = marketAssetConfig.vault ?? marketAssetConfig[0];

const verifyChildSet = async (label, controller, vaultAddress, auctionAddress, escrowAddress) => {
  const [
    vaultController,
    vaultAsset,
    auctionController,
    escrowController,
    escrowPolicyPool,
    escrowToken,
    escrowValidator,
    factoryVaultController,
    factoryAuctionController,
    factoryEscrowController,
    factoryVaultToken,
    factoryEscrowToken,
    factoryVaultType,
    factoryAuctionType,
    factoryEscrowType,
  ] = await Promise.all([
    publicClient.readContract({ address: vaultAddress, abi: artifacts.CollateralVaultV2.abi, functionName: 'controller' }),
    publicClient.readContract({ address: vaultAddress, abi: artifacts.CollateralVaultV2.abi, functionName: 'asset' }),
    publicClient.readContract({ address: auctionAddress, abi: artifacts.DutchAuctionV2.abi, functionName: 'controller' }),
    publicClient.readContract({ address: escrowAddress, abi: artifacts.SettlementEscrowV2.abi, functionName: 'controller' }),
    publicClient.readContract({ address: escrowAddress, abi: artifacts.SettlementEscrowV2.abi, functionName: 'policyPool' }),
    publicClient.readContract({ address: escrowAddress, abi: artifacts.SettlementEscrowV2.abi, functionName: 'settlementToken' }),
    publicClient.readContract({ address: escrowAddress, abi: artifacts.SettlementEscrowV2.abi, functionName: 'validator' }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleController', args: [vaultAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleController', args: [auctionAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleController', args: [escrowAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleToken', args: [vaultAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleToken', args: [escrowAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleType', args: [vaultAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleType', args: [auctionAddress] }),
    publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'moduleType', args: [escrowAddress] }),
  ]);
  const expectedController = controller.toLowerCase();
  if ([vaultController, auctionController, escrowController, escrowPolicyPool]
    .some((value) => value.toLowerCase() !== expectedController)) {
    throw new Error(`${label} child controller/policy-pool binding mismatch`);
  }
  if (vaultAsset.toLowerCase() !== cvaAsset.toLowerCase()) throw new Error(`${label} vault asset mismatch`);
  if (escrowToken.toLowerCase() !== settlementToken.toLowerCase()) throw new Error(`${label} escrow token mismatch`);
  if (escrowValidator.toLowerCase() !== complianceValidator.toLowerCase()) {
    throw new Error(`${label} escrow validator mismatch`);
  }
  if ([factoryVaultController, factoryAuctionController, factoryEscrowController]
    .some((value) => value.toLowerCase() !== expectedController)) {
    throw new Error(`${label} factory module-controller registry mismatch`);
  }
  if (
    factoryVaultToken.toLowerCase() !== cvaAsset.toLowerCase()
      || factoryEscrowToken.toLowerCase() !== settlementToken.toLowerCase()
      || Number(factoryVaultType) !== 1
      || Number(factoryAuctionType) !== 2
      || Number(factoryEscrowType) !== 3
  ) throw new Error(`${label} factory module type/token registry mismatch`);
};

await Promise.all([
  verifyChildSet('market', repoMarket.address, marketVault, marketAuction, marketEscrow),
  verifyChildSet('margin', marginEngine.address, marginVault, marginAuction, marginEscrow),
]);

const deployedCodeRecord = async (target, contractName) => {
  const code = await publicClient.getBytecode({ address: target });
  if (!code || code === '0x') throw new Error(`${contractName} child has no deployed code at ${target}`);
  const deployedRuntimeCodeBytes = (code.length - 2) / 2;
  const compiledRuntimeCodeBytes = (artifacts[contractName].deployedBytecode.length - 2) / 2;
  if (deployedRuntimeCodeBytes !== compiledRuntimeCodeBytes) {
    throw new Error(`${contractName} child runtime size mismatch at ${target}`);
  }
  return { address: target, deployedRuntimeCodeHash: keccak256(code), deployedRuntimeCodeBytes };
};

const deployedCode = Object.fromEntries(await Promise.all([
  ['assetRegistry', assetRegistry.address, 'CvaAssetRegistry'],
  ['moduleFactory', moduleFactory.address, 'ProtocolModuleFactoryV2'],
  ['riskManager', riskManager.address, 'RiskManagerV2'],
  ['valuationOracle', valuationOracle.address, 'SignedValuationOracle'],
  ['repoMarket', repoMarket.address, 'RepoMarketV2'],
  ['marketVault', marketVault, 'CollateralVaultV2'],
  ['marketAuction', marketAuction, 'DutchAuctionV2'],
  ['marketSettlementEscrow', marketEscrow, 'SettlementEscrowV2'],
  ['marginEngine', marginEngine.address, 'MarginEngineV2'],
  ['marginVault', marginVault, 'CollateralVaultV2'],
  ['marginAuction', marginAuction, 'DutchAuctionV2'],
  ['marginSettlementEscrow', marginEscrow, 'SettlementEscrowV2'],
].map(async ([key, target, contractName]) => [key, await deployedCodeRecord(target, contractName)])));

// This is intentionally emitted as a non-active draft. Release operations must
// compare it to the finalized ownership, Cleanverse and smoke-test evidence,
// then change only `status` to ACTIVE for the reviewed frontend build.
const frontendTrustedManifestDraft = {
  schemaVersion: 1,
  protocolVersion: 'v2',
  status: 'DEPLOYED_NOT_ACTIVE',
  chainId: CHAIN_ID,
  deploymentId: `${CHAIN_ID}:${repoMarket.address.toLowerCase()}:${sourceRevision}`,
  contracts: {
    repoMarket: { address: repoMarket.address, runtimeCodeHash: deployedCode.repoMarket.deployedRuntimeCodeHash },
    collateralVault: { address: marketVault, runtimeCodeHash: deployedCode.marketVault.deployedRuntimeCodeHash },
    auctionHouse: { address: marketAuction, runtimeCodeHash: deployedCode.marketAuction.deployedRuntimeCodeHash },
    settlementEscrow: { address: marketEscrow, runtimeCodeHash: deployedCode.marketSettlementEscrow.deployedRuntimeCodeHash },
    marginEngine: { address: marginEngine.address, runtimeCodeHash: deployedCode.marginEngine.deployedRuntimeCodeHash },
    marginVault: { address: marginVault, runtimeCodeHash: deployedCode.marginVault.deployedRuntimeCodeHash },
    marginAuctionHouse: { address: marginAuction, runtimeCodeHash: deployedCode.marginAuction.deployedRuntimeCodeHash },
    marginSettlementEscrow: { address: marginEscrow, runtimeCodeHash: deployedCode.marginSettlementEscrow.deployedRuntimeCodeHash },
    valuationOracle: { address: valuationOracle.address, runtimeCodeHash: deployedCode.valuationOracle.deployedRuntimeCodeHash },
    riskManager: { address: riskManager.address, runtimeCodeHash: deployedCode.riskManager.deployedRuntimeCodeHash },
  },
  settlementToken: {
    address: settlementToken,
    name: liveSettlementName,
    symbol: liveSettlementSymbol,
    decimals: Number(liveSettlementDecimals),
    runtimeCodeHash: keccak256(settlementRuntime),
  },
  marginAsset: {
    address: cvaAsset,
    name: liveCvaName,
    symbol: liveCvaSymbol,
    decimals: Number(liveCvaDecimals),
    runtimeCodeHash: keccak256(cvaRuntime),
  },
  assets: [{
    address: cvaAsset,
    vault: marketVault,
    name: liveCvaName,
    symbol: liveCvaSymbol,
    decimals: Number(liveCvaDecimals),
    runtimeCodeHash: keccak256(cvaRuntime),
  }],
};

await write('scheduleRiskConfig', riskManager, 'scheduleConfig', [cvaAsset, riskConfig]);
await write('setMarketPauseGuardian', repoMarket, 'setPauseGuardian', [pauseGuardian]);
await write('pauseMarketEntry', repoMarket, 'setEntryPaused', [true]);
await write('setMarginPauseGuardian', marginEngine, 'setPauseGuardian', [pauseGuardian]);
await write('pauseMarginEntry', marginEngine, 'setEntryPaused', [true]);

for (const [key, contract] of [
  ['transferRegistryOwnership', assetRegistry],
  ['transferRiskManagerOwnership', riskManager],
  ['transferOracleOwnership', valuationOracle],
  ['transferMarketOwnership', repoMarket],
  ['transferMarginOwnership', marginEngine],
]) {
  await write(key, contract, 'transferOwnership', [owner]);
}

const ownedContracts = {
  assetRegistry,
  riskManager,
  valuationOracle,
  repoMarket,
  marginEngine,
};
const ownershipState = Object.fromEntries(await Promise.all(Object.entries(ownedContracts).map(async ([key, contract]) => {
  const [currentOwner, pendingOwner] = await Promise.all([
    publicClient.readContract({ address: contract.address, abi: contract.abi, functionName: 'owner' }),
    publicClient.readContract({ address: contract.address, abi: contract.abi, functionName: 'pendingOwner' }),
  ]);
  if (currentOwner.toLowerCase() !== deployer.toLowerCase() || pendingOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`${key} ownership handoff state does not match the deployment plan`);
  }
  return [key, { currentOwner, pendingOwner, accepted: false }];
})));
const [factoryOwner, factoryPendingOwner, factoryValidator] = await Promise.all([
  publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'owner' }),
  publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'pendingOwner' }),
  publicClient.readContract({ address: moduleFactory.address, abi: moduleFactory.abi, functionName: 'validator' }),
]);
if (
  factoryOwner.toLowerCase() !== factoryActivationOwner.toLowerCase()
    || factoryPendingOwner.toLowerCase() !== ZERO_ADDRESS
    || factoryValidator.toLowerCase() !== complianceValidator.toLowerCase()
) throw new Error('Module factory owner/validator binding does not match the deployment plan');
ownershipState.moduleFactory = {
  currentOwner: factoryOwner,
  pendingOwner: factoryPendingOwner,
  finalOwner: owner,
  activationComplete: false,
  accepted: false,
};
const [pendingRiskConfig, liveSignerSet] = await Promise.all([
  publicClient.readContract({ address: riskManager.address, abi: riskManager.abi, functionName: 'pendingConfigs', args: [cvaAsset] }),
  publicClient.readContract({ address: valuationOracle.address, abi: valuationOracle.abi, functionName: 'signerSet' }),
]);
const pendingRiskHash = pendingRiskConfig.configHash ?? pendingRiskConfig[0];
const pendingRiskExecuteAfter = pendingRiskConfig.executeAfter ?? pendingRiskConfig[1];
const signerSetVerified = liveSignerSet.every((signer, index) => (
  signer.toLowerCase() === oracleSigners[index].toLowerCase()
));
if (!signerSetVerified) throw new Error('Deployed oracle signer set does not match the plan');
const [marketEntryPaused, marginEntryPaused, marketAssetState, marginCustodyReady] = await Promise.all([
  publicClient.readContract({ address: repoMarket.address, abi: repoMarket.abi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: marginEngine.address, abi: marginEngine.abi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: repoMarket.address, abi: repoMarket.abi, functionName: 'getAssetConfig', args: [cvaAsset] }),
  publicClient.readContract({ address: marginEngine.address, abi: marginEngine.abi, functionName: 'cleanverseCustodyReady' }),
]);
const marketCustodyReady = marketAssetState.cleanverseReady ?? marketAssetState[2];
if (!marketEntryPaused || !marginEntryPaused || marketCustodyReady || marginCustodyReady) {
  throw new Error('Deployment handoff must have entry paused and both Cleanverse readiness gates false');
}

const source = (module, deployedContract, metadata = {}) => ({
  module,
  address: deployedContract.address ?? deployedContract,
  deploymentBlock: (deployedContract.blockNumber ?? metadata.deploymentBlock).toString(),
  metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'deploymentBlock')),
});
const marketChildBlock = repoMarket.blockNumber;
const marginChildBlock = marginEngine.blockNumber;
const indexerSources = [
  source('REPO_MARKET', repoMarket, { engine: 'isolated' }),
  source('COLLATERAL_VAULT', marketVault, { engine: 'isolated', controllerAddress: repoMarket.address, asset: cvaAsset, deploymentBlock: configureAssetReceipt.blockNumber }),
  source('SETTLEMENT_ESCROW', marketEscrow, { engine: 'isolated', controllerAddress: repoMarket.address, policyPool: repoMarket.address, deploymentBlock: marketChildBlock }),
  source('DUTCH_AUCTION', marketAuction, { engine: 'isolated', controllerAddress: repoMarket.address, deploymentBlock: marketChildBlock }),
  source('VALUATION_ORACLE', valuationOracle),
  source('RISK_MANAGER', riskManager),
  source('MARGIN_ENGINE', marginEngine, { engine: 'cross-margin', asset: cvaAsset }),
  source('COLLATERAL_VAULT', marginVault, { engine: 'cross-margin', controllerAddress: marginEngine.address, asset: cvaAsset, deploymentBlock: marginChildBlock }),
  source('SETTLEMENT_ESCROW', marginEscrow, { engine: 'cross-margin', controllerAddress: marginEngine.address, policyPool: marginEngine.address, deploymentBlock: marginChildBlock }),
  source('DUTCH_AUCTION', marginAuction, { engine: 'cross-margin', controllerAddress: marginEngine.address, deploymentBlock: marginChildBlock }),
];

console.log(JSON.stringify({
  ...baseManifest,
  status: 'DEPLOYED_NOT_ACTIVE',
  contracts: {
    assetRegistry: assetRegistry.address,
    moduleFactory: moduleFactory.address,
    riskManager: riskManager.address,
    valuationOracle: valuationOracle.address,
    repoMarket: repoMarket.address,
    marketVault,
    marketAuction,
    marketSettlementEscrow: marketEscrow,
    marginEngine: marginEngine.address,
    marginVault,
    marginAuction,
    marginSettlementEscrow: marginEscrow,
  },
  deploymentBlocks: {
    assetRegistry: assetRegistry.blockNumber.toString(),
    moduleFactory: moduleFactory.blockNumber.toString(),
    riskManager: riskManager.blockNumber.toString(),
    valuationOracle: valuationOracle.blockNumber.toString(),
    repoMarket: repoMarket.blockNumber.toString(),
    marketVault: configureAssetReceipt.blockNumber.toString(),
    marginEngine: marginEngine.blockNumber.toString(),
  },
  transactions: transactionRecords,
  deployedCode,
  frontendTrustedManifestDraft,
  serviceConfiguration: {
    PROTOCOL_MODULE_FACTORY_V2_ADDRESS: moduleFactory.address,
    REPO_MARKET_V2_ADDRESS: repoMarket.address,
    COLLATERAL_VAULT_V2_ADDRESS: marketVault,
    SETTLEMENT_ESCROW_V2_ADDRESS: marketEscrow,
    DUTCH_AUCTION_V2_ADDRESS: marketAuction,
    MARGIN_ENGINE_V2_ADDRESS: marginEngine.address,
    VALUATION_ORACLE_V2_ADDRESS: valuationOracle.address,
    RISK_MANAGER_V2_ADDRESS: riskManager.address,
    V2_SETTLEMENT_TOKEN_ADDRESS: settlementToken,
    V2_ALLOWED_DURATIONS: allowedDurations.join(','),
    V2_MARGIN_ENABLED: false,
    V2_REPO_POLICY_POOL_REGISTERED: false,
    V2_FEE_TREASURY_AUSDC_ELIGIBLE: false,
    V2_SETTLEMENT_ESCROW_AUSDC_READY: false,
    V2_MARGIN_POLICY_POOL_REGISTERED: false,
    V2_MARGIN_VAULT_CUSTODY_READY: false,
    V2_MARGIN_ESCROW_AUSDC_READY: false,
    V2_MARGIN_TREASURY_AUSDC_ELIGIBLE: false,
    V2_DEPLOYMENTS_JSON: JSON.stringify(indexerSources),
  },
  ownership: {
    contracts: ownershipState,
    acceptanceTransactions: {},
  },
  riskActivation: {
    scheduled: true,
    configHash: pendingRiskHash,
    scheduledTransaction: transactionRecords.scheduleRiskConfig.txHash,
    executeAfter: pendingRiskExecuteAfter.toString(),
    applied: false,
    appliedTransaction: null,
  },
  oracleActivation: {
    signerSetVerified,
    valuationDigest: null,
    evidenceHash: null,
    nonce: null,
    validUntil: null,
    acceptedTransaction: null,
  },
  cleanverse: {
    moduleFactoryRegistrarRole: { granted: false, requestId: null, transactionHash: null },
    marketPolicyPool: { registered: false, ruleDigest: null, requestId: null, transactionHash: null },
    marketVault: { registered: false, asset: cvaAsset, requestId: null, transactionHash: null },
    marketSettlementEscrow: { registered: false, asset: settlementToken, requestId: null, transactionHash: null },
    marginPolicyPool: { registered: false, ruleDigest: null, requestId: null, transactionHash: null },
    marginVault: { registered: false, asset: cvaAsset, requestId: null, transactionHash: null },
    marginSettlementEscrow: { registered: false, asset: settlementToken, requestId: null, transactionHash: null },
  },
  smokeProofs: {
    marketVaultDeposit: null,
    marketVaultWithdrawal: null,
    marketEscrowFundAndClaim: null,
    marginVaultDeposit: null,
    marginVaultWithdrawal: null,
    marginEscrowFundAndClaim: null,
    reconciliationReportHash: null,
  },
  readiness: {
    marketAssetVaultReadyTransaction: null,
    marginCustodyReadyTransaction: null,
    isolatedEntryUnpausedTransaction: null,
    marginEntryUnpausedTransaction: null,
    partialFillsEnabled: false,
    earlyRepurchaseEnabled: false,
    dutchAuctionsEnabled: false,
    crossMarginEnabled: false,
  },
  indexerSources,
  requiredNextSteps: [
    'Persist this manifest and every submitted transaction line in release evidence.',
    'Before ownership acceptance, have the current EOA owners sign the exact Cleanverse pool/factory messages; register both pools and record their approved RuleV2 evidence.',
    'Grant REGISTER_ROLE to the exact factory, then have its activation owner call registerCvaCustody for each exact vault/CVA and escrow/settlement-token pair.',
    'After those transactions confirm, transfer factory ownership to the reviewed final owner and have it accept; then have the pending owner accept registry, risk manager, oracle, market, and margin engine ownership.',
    'Wait for the configured risk delay, then have the multisig apply the exact scheduled risk config.',
    'Submit a fresh 2-of-3 signed valuation and execute real deposit/withdraw/escrow claim smoke proofs.',
    'Only then set readiness true and unpause isolated entry; enable cross-margin last.',
    'After every activation proof passes, review frontendTrustedManifestDraft, change only its status to ACTIVE, and provide its compact JSON as VITE_TRUSTED_V2_MANIFEST_JSON at frontend build time.',
  ],
}, null, 2));
