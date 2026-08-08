export const MONAD_TESTNET = {
  id: 10_143,
  cleanverseChain: 'monad',
  name: 'Monad Testnet',
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  explorerUrl: 'https://testnet.monadscan.com',
} as const;

export const CLEANVERSE_UAT_BASE_URL = 'https://uatapi.cleanverse.com/api/cooperate';

export const CONTRACTS = {
  validator: '0xaC7e5179C2C7f03f209136886c172eb34F161792',
  rwcarReceivableNote: '0x7A33e03B10268FFdB50e562721B092BC0Cb793F9',
  aUsdc: '0xaC0893567D43C3E7e6e35a72803df05416C1f20D',
  assetRegistry: '0x38a859695c32eea74b51c0f098039e15e616d5d6',
  repoMarket: '0x90535a7176a3b2c251c834b28e11e245622ee808',
} as const;

export const TOKEN_DECIMALS = 6;
export const PROTOCOL_FEE_BPS = 15;
export const BPS_DENOMINATOR = 10_000;
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export const UAT_TERMS = {
  allowedDurations: [5 * 60],
  gracePeriod: 2 * 60,
} as const;

export const PRODUCTION_TERMS = {
  allowedDurations: [7 * 86_400, 14 * 86_400, 30 * 86_400],
  gracePeriod: 86_400,
} as const;
