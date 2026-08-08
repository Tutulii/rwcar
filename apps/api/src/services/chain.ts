import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  http,
  type Address,
} from 'viem';
import {
  erc20Abi,
  marginEngineV2Abi,
  MONAD_TESTNET,
  protocolModuleFactoryV2Abi,
  signedValuationOracleAbi,
} from '@rwcar/shared';
import type { ApiConfig } from '../config.js';

const validatorAbi = [{
  type: 'function',
  name: 'complianceVerify',
  stateMutability: 'view',
  inputs: [{ name: 'poolAddress', type: 'address' }, { name: 'userAddress', type: 'address' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

// Multicall3 is deployed at the canonical address on Monad Testnet. Configuring
// it explicitly lets viem aggregate the metadata reads used by /v2/config
// instead of bursting dozens of eth_call requests into the public RPC.
const monadMulticall3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

const marketReadAbi = [{
  type: 'function',
  name: 'feeTreasury',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'address' }],
}] as const;

const vaultReadAbi = [{
  type: 'function',
  name: 'availableBalance',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

const auctionReadAbi = [{
  type: 'function',
  name: 'currentPrice',
  stateMutability: 'view',
  inputs: [{ name: 'auctionId', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

const marketV2ReadAbi = [
  { type: 'function', name: 'settlementToken', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'assetRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'valuationOracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'riskManager', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'auctionHouse', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'settlementEscrow', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'feeTreasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'entryPaused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  {
    type: 'function', name: 'getAssetConfig', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'vault', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'cleanverseReady', type: 'bool' },
    ] }],
  },
  {
    type: 'function', name: 'previewFill', stateMutability: 'view',
    inputs: [{ name: 'offerId', type: 'uint256' }, { name: 'fillPrincipal', type: 'uint256' }],
    outputs: [
      { name: 'collateralForFill', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'sellerProceeds', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'previewPayoff', stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }, { name: 'atTimestamp', type: 'uint256' }],
    outputs: [{ name: 'payoff', type: 'uint256' }],
  },
] as const;

const assetRegistryReadAbi = [{
  type: 'function', name: 'isAssetEnabled', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
}] as const;

const tokenMetadataReadAbi = [{
  type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }],
}] as const;

const atokenPolicyAddressAbi = [{
  type: 'function', name: 'policy', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}] as const;

const atokenPolicyPauseAbi = [{
  type: 'function', name: 'isPaused', stateMutability: 'view',
  inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
}] as const;

const riskManagerReadAbi = [{
  type: 'function', name: 'getConfig', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }],
  outputs: [{ name: 'config', type: 'tuple', components: [
    { name: 'enabled', type: 'bool' }, { name: 'initialLtvBps', type: 'uint16' },
    { name: 'maintenanceLtvBps', type: 'uint16' }, { name: 'liquidationLtvBps', type: 'uint16' },
    { name: 'auctionStartBps', type: 'uint16' }, { name: 'auctionFloorBps', type: 'uint16' },
    { name: 'liquidationFeeBps', type: 'uint16' }, { name: 'earlyMinHoldBps', type: 'uint16' },
    { name: 'earlyBreakFeeBps', type: 'uint16' }, { name: 'defaultSpreadBps', type: 'uint32' },
    { name: 'maxDefaultRateBps', type: 'uint32' }, { name: 'maxOracleAge', type: 'uint64' },
    { name: 'auctionDuration', type: 'uint64' }, { name: 'marginCallPeriod', type: 'uint64' },
    { name: 'staleOracleFallbackDelay', type: 'uint64' },
  ] }],
}] as const;

const valuationOracleReadAbi = [{
  type: 'function', name: 'freshPrice', stateMutability: 'view',
  inputs: [
    { name: 'asset', type: 'address' }, { name: 'settlementToken', type: 'address' }, { name: 'maxAge', type: 'uint256' },
  ],
  outputs: [
    { name: 'priceE18', type: 'uint256' }, { name: 'observedAt', type: 'uint64' }, { name: 'digest', type: 'bytes32' },
  ],
}] as const;

export type V2RiskConfig = {
  enabled: boolean;
  initialLtvBps: number;
  maintenanceLtvBps: number;
  liquidationLtvBps: number;
  auctionStartBps: number;
  auctionFloorBps: number;
  liquidationFeeBps: number;
  earlyMinHoldBps: number;
  earlyBreakFeeBps: number;
  defaultSpreadBps: number;
  maxDefaultRateBps: number;
  maxOracleAge: bigint;
  auctionDuration: bigint;
  marginCallPeriod: bigint;
  staleOracleFallbackDelay: bigint;
};

export type MarginMetadata = {
  asset: Address;
  settlementToken: Address;
  assetRegistry: Address;
  valuationOracle: Address;
  riskManager: Address;
  vault: Address;
  auctionHouse: Address;
  settlementEscrow: Address;
  feeTreasury: Address;
  protocolFeeBps: number;
  gracePeriod: bigint;
  assetDecimals: number;
  settlementDecimals: number;
  cleanverseCustodyReady: boolean;
  entryPaused: boolean;
};

export type MarketMetadata = {
  settlementToken: Address;
  assetRegistry: Address;
  valuationOracle: Address;
  riskManager: Address;
  auctionHouse: Address;
  settlementEscrow: Address;
  feeTreasury: Address;
  entryPaused: boolean;
};

export type FactoryMetadata = {
  owner: Address;
  pendingOwner: Address;
  validator: Address;
};

export type FactoryModuleMetadata = {
  controller: Address;
  token: Address;
  moduleType: number;
};

export type MarginAccountState = {
  seller: Address;
  permittedLender: Address;
  collateralAmount: bigint;
  fundingTarget: bigint;
  minimumFunding: bigint;
  totalFunded: bigint;
  totalFaceDebt: bigint;
  feeCharged: bigint;
  frozenDebt: bigint;
  liquidationProceeds: bigint;
  remainingProceeds: bigint;
  remainingCollateral: bigint;
  marginCallDeadline: bigint;
  defaultDeclaredAt: bigint;
  fundingDuration: bigint;
  fundingExpiry: bigint;
  maxOracleAge: bigint;
  auctionDuration: bigint;
  marginCallPeriod: bigint;
  staleOracleFallbackDelay: bigint;
  activeExposureCount: number;
  unclaimedExposureCount: number;
  maxAnnualRateBps: number;
  initialLtvBps: number;
  maintenanceLtvBps: number;
  liquidationLtvBps: number;
  auctionStartBps: number;
  auctionFloorBps: number;
  liquidationFeeBps: number;
  paymentDefaultDeclared: boolean;
  inKindCloseout: boolean;
  fundingClosed: boolean;
  status: number;
  auctionId: bigint;
  claimPoolId: bigint;
  closeoutValuationDigest: `0x${string}`;
};

export type MarginExposureState = {
  accountId: bigint;
  lender: Address;
  principal: bigint;
  faceDebt: bigint;
  openedAt: bigint;
  maturity: bigint;
  status: number;
};

export type ValuationAttestation = {
  asset: Address;
  settlementToken: Address;
  priceE18: bigint;
  observedAt: bigint;
  validUntil: bigint;
  nonce: bigint;
  evidenceHash: `0x${string}`;
};

export interface ChainService {
  balanceOf(token: Address, account: Address): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  poolEligible(validator: Address, pool: Address, user: Address): Promise<boolean>;
  feeTreasury(market: Address): Promise<Address>;
  marketMetadata(market: Address): Promise<MarketMetadata>;
  assetEnabled(registry: Address, asset: Address): Promise<boolean>;
  tokenDecimals(token: Address): Promise<number>;
  tokenPolicyState(token: Address): Promise<{ policy: Address; paused: boolean }>;
  blockNumber(): Promise<bigint>;
  blockTimestamp(blockNumber?: bigint): Promise<bigint>;
  vaultAvailable(vault: Address, account: Address): Promise<bigint>;
  auctionPrice(auction: Address, auctionId: bigint): Promise<bigint>;
  marketAssetConfig(market: Address, asset: Address): Promise<{ vault: Address; decimals: number; cleanverseReady: boolean }>;
  previewFill(market: Address, offerId: bigint, fillPrincipal: bigint): Promise<{ collateral: bigint; fee: bigint; sellerProceeds: bigint }>;
  previewPayoff(market: Address, positionId: bigint, atTimestamp: bigint): Promise<bigint>;
  riskConfig(riskManager: Address, asset: Address): Promise<V2RiskConfig>;
  freshPrice(oracle: Address, asset: Address, settlementToken: Address, maxAge: bigint): Promise<{ priceE18: bigint; observedAt: bigint; digest: `0x${string}` }>;
  hasFreshPrice(oracle: Address, asset: Address, settlementToken: Address, maxAge: bigint): Promise<boolean>;
  marginMetadata(engine: Address): Promise<MarginMetadata>;
  marginAccount(engine: Address, accountId: bigint): Promise<MarginAccountState>;
  marginExposure(engine: Address, exposureId: bigint): Promise<MarginExposureState>;
  marginAccountLtv(engine: Address, accountId: bigint): Promise<bigint>;
  simulateTransaction(account: Address, to: Address, data: `0x${string}`): Promise<void>;
  valuationSignerSet(oracle: Address): Promise<readonly [Address, Address, Address]>;
  valuationNonceState(oracle: Address, asset: Address, nonce: bigint): Promise<{ lastNonce: bigint; unavailable: boolean }>;
  valuationDigest(oracle: Address, attestation: ValuationAttestation): Promise<`0x${string}`>;
  contractOwner(contract: Address): Promise<Address>;
  factoryMetadata(factory: Address): Promise<FactoryMetadata>;
  factoryModule(factory: Address, module: Address): Promise<FactoryModuleMetadata>;
}

export function createChainService(config: ApiConfig): ChainService {
  const chain = defineChain({
    id: MONAD_TESTNET.id,
    name: MONAD_TESTNET.name,
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
    contracts: { multicall3: { address: monadMulticall3 } },
  });
  const client = createPublicClient({
    chain,
    batch: { multicall: { wait: 5 } },
    transport: http(config.MONAD_RPC_URL, { timeout: 10_000, retryCount: 2 }),
  });
  const readFreshPrice = async (oracle: Address, asset: Address, settlementToken: Address, maxAge: bigint) => {
    const [priceE18, observedAt, digest] = await client.readContract({
      address: oracle, abi: valuationOracleReadAbi, functionName: 'freshPrice', args: [asset, settlementToken, maxAge],
    });
    return { priceE18, observedAt, digest };
  };

  return {
    async balanceOf(token: Address, account: Address) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
    },
    async allowance(token: Address, owner: Address, spender: Address) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
    },
    async poolEligible(validator: Address, pool: Address, user: Address) {
      return client.readContract({ address: validator, abi: validatorAbi, functionName: 'complianceVerify', args: [pool, user] });
    },
    async feeTreasury(market: Address) {
      return client.readContract({ address: market, abi: marketReadAbi, functionName: 'feeTreasury' });
    },
    async marketMetadata(market: Address) {
      const [settlementToken, assetRegistry, valuationOracle, riskManager, auctionHouse, settlementEscrow, feeTreasury, entryPaused] = await Promise.all([
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'settlementToken' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'assetRegistry' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'valuationOracle' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'riskManager' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'auctionHouse' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'settlementEscrow' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'feeTreasury' }),
        client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'entryPaused' }),
      ]);
      return { settlementToken, assetRegistry, valuationOracle, riskManager, auctionHouse, settlementEscrow, feeTreasury, entryPaused };
    },
    async assetEnabled(registry: Address, asset: Address) {
      return client.readContract({ address: registry, abi: assetRegistryReadAbi, functionName: 'isAssetEnabled', args: [asset] });
    },
    async tokenDecimals(token: Address) {
      return client.readContract({ address: token, abi: tokenMetadataReadAbi, functionName: 'decimals' });
    },
    async tokenPolicyState(token: Address) {
      const policy = await client.readContract({ address: token, abi: atokenPolicyAddressAbi, functionName: 'policy' });
      const paused = await client.readContract({
        address: policy, abi: atokenPolicyPauseAbi, functionName: 'isPaused', args: [token],
      });
      return { policy, paused };
    },
    async blockNumber() {
      return client.getBlockNumber();
    },
    async blockTimestamp(blockNumber?: bigint) {
      return (await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber })).timestamp;
    },
    async vaultAvailable(vault: Address, account: Address) {
      return client.readContract({ address: vault, abi: vaultReadAbi, functionName: 'availableBalance', args: [account] });
    },
    async auctionPrice(auction: Address, auctionId: bigint) {
      return client.readContract({ address: auction, abi: auctionReadAbi, functionName: 'currentPrice', args: [auctionId] });
    },
    async marketAssetConfig(market: Address, asset: Address) {
      const result = await client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'getAssetConfig', args: [asset] });
      return { vault: result.vault, decimals: result.decimals, cleanverseReady: result.cleanverseReady };
    },
    async previewFill(market: Address, offerId: bigint, fillPrincipal: bigint) {
      const [collateral, fee, sellerProceeds] = await client.readContract({
        address: market, abi: marketV2ReadAbi, functionName: 'previewFill', args: [offerId, fillPrincipal],
      });
      return { collateral, fee, sellerProceeds };
    },
    async previewPayoff(market: Address, positionId: bigint, atTimestamp: bigint) {
      return client.readContract({ address: market, abi: marketV2ReadAbi, functionName: 'previewPayoff', args: [positionId, atTimestamp] });
    },
    async riskConfig(riskManager: Address, asset: Address) {
      const result = await client.readContract({ address: riskManager, abi: riskManagerReadAbi, functionName: 'getConfig', args: [asset] });
      return {
        enabled: result.enabled,
        initialLtvBps: result.initialLtvBps,
        maintenanceLtvBps: result.maintenanceLtvBps,
        liquidationLtvBps: result.liquidationLtvBps,
        auctionStartBps: result.auctionStartBps,
        auctionFloorBps: result.auctionFloorBps,
        liquidationFeeBps: result.liquidationFeeBps,
        earlyMinHoldBps: result.earlyMinHoldBps,
        earlyBreakFeeBps: result.earlyBreakFeeBps,
        defaultSpreadBps: result.defaultSpreadBps,
        maxDefaultRateBps: result.maxDefaultRateBps,
        maxOracleAge: result.maxOracleAge,
        auctionDuration: result.auctionDuration,
        marginCallPeriod: result.marginCallPeriod,
        staleOracleFallbackDelay: result.staleOracleFallbackDelay,
      };
    },
    async freshPrice(oracle: Address, asset: Address, settlementToken: Address, maxAge: bigint) {
      return readFreshPrice(oracle, asset, settlementToken, maxAge);
    },
    async hasFreshPrice(oracle: Address, asset: Address, settlementToken: Address, maxAge: bigint) {
      try {
        await readFreshPrice(oracle, asset, settlementToken, maxAge);
        return true;
      } catch (error) {
        const reverted = error instanceof ContractFunctionRevertedError
          || (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError);
        if (reverted) return false;
        throw error;
      }
    },
    async marginMetadata(engine: Address) {
      const [asset, settlementToken, assetRegistry, valuationOracle, riskManager, vault, auctionHouse, settlementEscrow, feeTreasury, protocolFeeBps, gracePeriod, assetDecimals, settlementDecimals, cleanverseCustodyReady, entryPaused] = await Promise.all([
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'asset' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'settlementToken' }),
        client.readContract({ address: engine, abi: [{ type: 'function', name: 'assetRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const, functionName: 'assetRegistry' }),
        client.readContract({ address: engine, abi: [{ type: 'function', name: 'valuationOracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const, functionName: 'valuationOracle' }),
        client.readContract({ address: engine, abi: [{ type: 'function', name: 'riskManager', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const, functionName: 'riskManager' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'vault' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'auctionHouse' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'settlementEscrow' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'feeTreasury' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'protocolFeeBps' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'gracePeriod' }),
        client.readContract({ address: engine, abi: [{ type: 'function', name: 'assetDecimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }] as const, functionName: 'assetDecimals' }),
        client.readContract({ address: engine, abi: [{ type: 'function', name: 'settlementDecimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }] as const, functionName: 'settlementDecimals' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'cleanverseCustodyReady' }),
        client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'entryPaused' }),
      ]);
      return { asset, settlementToken, assetRegistry, valuationOracle, riskManager, vault, auctionHouse, settlementEscrow, feeTreasury, protocolFeeBps, gracePeriod, assetDecimals, settlementDecimals, cleanverseCustodyReady, entryPaused };
    },
    async marginAccount(engine: Address, accountId: bigint) {
      return client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'getAccount', args: [accountId] });
    },
    async marginExposure(engine: Address, exposureId: bigint) {
      return client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'getExposure', args: [exposureId] });
    },
    async marginAccountLtv(engine: Address, accountId: bigint) {
      return client.readContract({ address: engine, abi: marginEngineV2Abi, functionName: 'accountLtv', args: [accountId] });
    },
    async simulateTransaction(account: Address, to: Address, data: `0x${string}`) {
      await client.call({ account, to, data });
    },
    async valuationSignerSet(oracle: Address) {
      return client.readContract({ address: oracle, abi: signedValuationOracleAbi, functionName: 'signerSet' });
    },
    async valuationNonceState(oracle: Address, asset: Address, nonce: bigint) {
      const [lastNonce, unavailable] = await Promise.all([
        client.readContract({ address: oracle, abi: signedValuationOracleAbi, functionName: 'lastNonce', args: [asset] }),
        client.readContract({ address: oracle, abi: signedValuationOracleAbi, functionName: 'nonceUnavailable', args: [asset, nonce] }),
      ]);
      return { lastNonce, unavailable };
    },
    async valuationDigest(oracle: Address, attestation: ValuationAttestation) {
      return client.readContract({ address: oracle, abi: signedValuationOracleAbi, functionName: 'hashAttestation', args: [attestation] });
    },
    async contractOwner(contract: Address) {
      return client.readContract({ address: contract, abi: protocolModuleFactoryV2Abi, functionName: 'owner' });
    },
    async factoryMetadata(factory: Address) {
      const [owner, pendingOwner, validator] = await Promise.all([
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'owner' }),
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'pendingOwner' }),
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'validator' }),
      ]);
      return { owner, pendingOwner, validator };
    },
    async factoryModule(factory: Address, module: Address) {
      const [controller, token, moduleType] = await Promise.all([
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'moduleController', args: [module] }),
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'moduleToken', args: [module] }),
        client.readContract({ address: factory, abi: protocolModuleFactoryV2Abi, functionName: 'moduleType', args: [module] }),
      ]);
      return { controller, token, moduleType };
    },
  };
}
