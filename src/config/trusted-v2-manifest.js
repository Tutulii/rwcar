// This file is compiled into the browser bundle and is the public, reviewed
// signing allowlist for RWCAR V2. It deliberately starts inactive. After the
// V2 deployment is reviewed, copy the exact addresses and *deployed* runtime
// code hashes from the release manifest and commit that change before enabling
// V2 in the API. Dynamic pause/readiness state never belongs in this manifest.
export const INACTIVE_V2_MANIFEST = Object.freeze({
  schemaVersion: 1,
  protocolVersion: 'v2',
  status: 'UNCONFIGURED',
  chainId: 10_143,
  deploymentId: 'monad-testnet-v2-unconfigured',
  contracts: Object.freeze({
    repoMarket: Object.freeze({ address: '', runtimeCodeHash: '' }),
    collateralVault: Object.freeze({ address: '', runtimeCodeHash: '' }),
    auctionHouse: Object.freeze({ address: '', runtimeCodeHash: '' }),
    settlementEscrow: Object.freeze({ address: '', runtimeCodeHash: '' }),
    marginEngine: Object.freeze({ address: '', runtimeCodeHash: '' }),
    marginVault: Object.freeze({ address: '', runtimeCodeHash: '' }),
    marginAuctionHouse: Object.freeze({ address: '', runtimeCodeHash: '' }),
    marginSettlementEscrow: Object.freeze({ address: '', runtimeCodeHash: '' }),
    valuationOracle: Object.freeze({ address: '', runtimeCodeHash: '' }),
    riskManager: Object.freeze({ address: '', runtimeCodeHash: '' }),
  }),
  settlementToken: Object.freeze({
    address: '0xaC0893567D43C3E7e6e35a72803df05416C1f20D',
    symbol: 'aUSDC',
    decimals: 6,
    // Cleanverse tokens may be upgradeable. Activation requires the reviewed
    // proxy runtime hash here; release evidence must separately govern and pin
    // any implementation upgrade path.
    runtimeCodeHash: '',
  }),
  marginAsset: Object.freeze({ address: '', symbol: '', name: '', decimals: 6, runtimeCodeHash: '' }),
  assets: Object.freeze([]),
});

export function parseTrustedV2Manifest(raw) {
  if (!raw) return INACTIVE_V2_MANIFEST;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { ...INACTIVE_V2_MANIFEST, status: 'INVALID' };
  } catch {
    return { ...INACTIVE_V2_MANIFEST, status: 'INVALID', deploymentId: 'invalid-build-manifest-json' };
  }
}

// Vite substitutes this at build time. It is public release metadata, never a
// secret. A missing value keeps V2 fail-closed while V1 remains available.
const buildEnvironment = import.meta.env || {};
export const TRUSTED_V2_MANIFEST = parseTrustedV2Manifest(buildEnvironment.VITE_TRUSTED_V2_MANIFEST_JSON);

export default TRUSTED_V2_MANIFEST;
