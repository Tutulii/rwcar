// Exact client/indexer ABI for the compiled immutable V2 modules. Keep this file in
// sync with packages/contracts/artifacts-solc before enabling a deployment source.
export const protocolModuleFactoryV2Abi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'pendingOwner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'validator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'moduleController', stateMutability: 'view', inputs: [{ name: 'module', type: 'address' }], outputs: [{ name: 'controller', type: 'address' }] },
  { type: 'function', name: 'moduleToken', stateMutability: 'view', inputs: [{ name: 'module', type: 'address' }], outputs: [{ name: 'token', type: 'address' }] },
  { type: 'function', name: 'moduleType', stateMutability: 'view', inputs: [{ name: 'module', type: 'address' }], outputs: [{ name: 'moduleType', type: 'uint8' }] },
  { type: 'function', name: 'custodyRegistered', stateMutability: 'view', inputs: [{ name: 'registrationKey', type: 'bytes32' }], outputs: [{ name: 'registered', type: 'bool' }] },
  { type: 'function', name: 'registerCvaCustody', stateMutability: 'nonpayable', inputs: [
    { name: 'pool', type: 'address' }, { name: 'aToken', type: 'address' }, { name: 'custodyAddress', type: 'address' },
  ], outputs: [] },
  { type: 'event', name: 'CvaCustodyRegistered', anonymous: false, inputs: [
    { indexed: true, name: 'pool', type: 'address' }, { indexed: true, name: 'aToken', type: 'address' },
    { indexed: true, name: 'custodyAddress', type: 'address' }, { indexed: false, name: 'registrationKey', type: 'bytes32' },
  ] },
] as const;

export const repoMarketV2Abi = [
  { type: 'function', name: 'depositCollateral', stateMutability: 'nonpayable', inputs: [
    { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
  ], outputs: [] },
  { type: 'function', name: 'withdrawCollateral', stateMutability: 'nonpayable', inputs: [
    { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [] },
  { type: 'function', name: 'createOffer', stateMutability: 'nonpayable', inputs: [
    { name: 'params', type: 'tuple', components: [
      { name: 'asset', type: 'address' }, { name: 'collateralAmount', type: 'uint128' },
      { name: 'targetPrincipal', type: 'uint128' }, { name: 'minimumFill', type: 'uint128' },
      { name: 'annualRateBps', type: 'uint32' }, { name: 'duration', type: 'uint64' },
      { name: 'offerExpiry', type: 'uint64' }, { name: 'permittedBuyer', type: 'address' },
      { name: 'earlyRepurchaseEnabled', type: 'bool' },
    ] },
  ], outputs: [{ name: 'offerId', type: 'uint256' }] },
  { type: 'function', name: 'fillOffer', stateMutability: 'nonpayable', inputs: [
    { name: 'offerId', type: 'uint256' }, { name: 'fillPrincipal', type: 'uint256' }, { name: 'maxFee', type: 'uint256' },
  ], outputs: [{ name: 'positionId', type: 'uint256' }] },
  { type: 'function', name: 'cancelOffer', stateMutability: 'nonpayable', inputs: [{ name: 'offerId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'finalizeOfferExpiry', stateMutability: 'nonpayable', inputs: [{ name: 'offerId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'repurchase', stateMutability: 'nonpayable', inputs: [
    { name: 'positionId', type: 'uint256' }, { name: 'maxPayoff', type: 'uint256' }, { name: 'useEscrow', type: 'bool' },
  ], outputs: [] },
  { type: 'function', name: 'startAuction', stateMutability: 'nonpayable', inputs: [{ name: 'positionId', type: 'uint256' }], outputs: [{ name: 'auctionId', type: 'uint256' }] },
  { type: 'function', name: 'buyAuction', stateMutability: 'nonpayable', inputs: [
    { name: 'auctionId', type: 'uint256' }, { name: 'maxPrice', type: 'uint256' },
  ], outputs: [] },
  { type: 'function', name: 'finalizeFailedAuction', stateMutability: 'nonpayable', inputs: [{ name: 'auctionId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimDefaultCollateral', stateMutability: 'nonpayable', inputs: [
    { name: 'positionId', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [] },
  { type: 'function', name: 'claimCollateralOnOracleFailure', stateMutability: 'nonpayable', inputs: [
    { name: 'positionId', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [] },
  { type: 'function', name: 'previewFill', stateMutability: 'view', inputs: [
    { name: 'offerId', type: 'uint256' }, { name: 'fillPrincipal', type: 'uint256' },
  ], outputs: [
    { name: 'collateralForFill', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'sellerProceeds', type: 'uint256' },
  ] },
  { type: 'function', name: 'previewPayoff', stateMutability: 'view', inputs: [
    { name: 'positionId', type: 'uint256' }, { name: 'atTimestamp', type: 'uint256' },
  ], outputs: [{ name: 'payoff', type: 'uint256' }] },
  { type: 'event', name: 'OfferCreated', anonymous: false, inputs: [
    { indexed: true, name: 'offerId', type: 'uint256' }, { indexed: true, name: 'seller', type: 'address' },
    { indexed: true, name: 'asset', type: 'address' }, { indexed: false, name: 'collateralAmount', type: 'uint256' },
    { indexed: false, name: 'targetPrincipal', type: 'uint256' }, { indexed: false, name: 'minimumFill', type: 'uint256' },
    { indexed: false, name: 'annualRateBps', type: 'uint256' }, { indexed: false, name: 'defaultAnnualRateBps', type: 'uint256' },
    { indexed: false, name: 'duration', type: 'uint256' }, { indexed: false, name: 'gracePeriod', type: 'uint256' },
    { indexed: false, name: 'offerExpiry', type: 'uint256' }, { indexed: false, name: 'permittedBuyer', type: 'address' },
    { indexed: false, name: 'earlyRepurchaseEnabled', type: 'bool' }, { indexed: false, name: 'earlyMinHoldBps', type: 'uint256' },
    { indexed: false, name: 'earlyBreakFeeBps', type: 'uint256' }, { indexed: false, name: 'valuationDigest', type: 'bytes32' },
  ] },
  { type: 'event', name: 'OfferFilled', anonymous: false, inputs: [
    { indexed: true, name: 'offerId', type: 'uint256' }, { indexed: true, name: 'positionId', type: 'uint256' },
    { indexed: true, name: 'buyer', type: 'address' }, { indexed: false, name: 'principal', type: 'uint256' },
    { indexed: false, name: 'collateral', type: 'uint256' }, { indexed: false, name: 'fee', type: 'uint256' },
    { indexed: false, name: 'maturity', type: 'uint256' }, { indexed: false, name: 'repaymentDeadline', type: 'uint256' },
    { indexed: false, name: 'defaultAnnualRateBps', type: 'uint256' },
    { indexed: false, name: 'liquidationFeeBps', type: 'uint256' },
    { indexed: false, name: 'auctionStartBps', type: 'uint256' },
    { indexed: false, name: 'auctionFloorBps', type: 'uint256' },
    { indexed: false, name: 'auctionDuration', type: 'uint256' },
    { indexed: false, name: 'maxOracleAge', type: 'uint256' },
    { indexed: false, name: 'staleOracleFallbackDelay', type: 'uint256' },
    { indexed: false, name: 'openingValuationDigest', type: 'bytes32' },
  ] },
  { type: 'event', name: 'OfferCancelled', anonymous: false, inputs: [
    { indexed: true, name: 'offerId', type: 'uint256' }, { indexed: false, name: 'collateralReleased', type: 'uint256' },
  ] },
  { type: 'event', name: 'OfferExpired', anonymous: false, inputs: [
    { indexed: true, name: 'offerId', type: 'uint256' }, { indexed: false, name: 'collateralReleased', type: 'uint256' },
  ] },
  { type: 'event', name: 'PositionRepaid', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: true, name: 'seller', type: 'address' },
    { indexed: true, name: 'buyer', type: 'address' }, { indexed: false, name: 'payoff', type: 'uint256' },
    { indexed: false, name: 'escrowed', type: 'bool' },
  ] },
  { type: 'event', name: 'PositionDefaulted', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: false, name: 'frozenDebt', type: 'uint256' },
    { indexed: true, name: 'auctionId', type: 'uint256' }, { indexed: true, name: 'valuationDigest', type: 'bytes32' },
  ] },
  { type: 'event', name: 'PositionLiquidated', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: true, name: 'auctionId', type: 'uint256' },
    { indexed: true, name: 'buyer', type: 'address' }, { indexed: false, name: 'salePrice', type: 'uint256' },
    { indexed: false, name: 'lenderPaid', type: 'uint256' }, { indexed: false, name: 'feePaid', type: 'uint256' },
    { indexed: false, name: 'sellerSurplus', type: 'uint256' }, { indexed: false, name: 'shortfall', type: 'uint256' },
  ] },
  { type: 'event', name: 'AuctionFailed', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: true, name: 'auctionId', type: 'uint256' },
  ] },
  { type: 'event', name: 'DefaultCollateralClaimed', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: true, name: 'lender', type: 'address' },
    { indexed: true, name: 'recipient', type: 'address' },
  ] },
  { type: 'event', name: 'StaleOracleCollateralClaimed', anonymous: false, inputs: [
    { indexed: true, name: 'positionId', type: 'uint256' }, { indexed: true, name: 'lender', type: 'address' },
    { indexed: true, name: 'recipient', type: 'address' },
  ] },
  { type: 'event', name: 'SettlementEscrowed', anonymous: false, inputs: [
    { indexed: true, name: 'beneficiary', type: 'address' }, { indexed: true, name: 'claimId', type: 'uint256' },
    { indexed: false, name: 'amount', type: 'uint256' }, { indexed: true, name: 'claimReference', type: 'bytes32' },
  ] },
] as const;

export const collateralVaultV2Abi = [
  { type: 'function', name: 'availableBalance', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'totalAccounted', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'isSolvent', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'event', name: 'VaultBalanceChanged', anonymous: false, inputs: [
    { indexed: true, name: 'account', type: 'address' }, { indexed: true, name: 'asset', type: 'address' },
    { indexed: true, name: 'bucket', type: 'bytes32' }, { indexed: false, name: 'delta', type: 'int256' },
    { indexed: false, name: 'balanceAfter', type: 'uint256' }, { indexed: false, name: 'referenceType', type: 'bytes32' },
    { indexed: false, name: 'referenceId', type: 'uint256' }, { indexed: false, name: 'reason', type: 'bytes32' },
  ] },
] as const;

export const dutchAuctionV2Abi = [
  { type: 'function', name: 'currentPrice', stateMutability: 'view', inputs: [{ name: 'auctionId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'event', name: 'AuctionStarted', anonymous: false, inputs: [
    { indexed: true, name: 'auctionId', type: 'uint256' }, { indexed: true, name: 'referenceKind', type: 'uint8' },
    { indexed: true, name: 'referenceId', type: 'uint256' }, { indexed: false, name: 'assetAmount', type: 'uint256' },
    { indexed: false, name: 'startPrice', type: 'uint256' }, { indexed: false, name: 'floorPrice', type: 'uint256' },
    { indexed: false, name: 'endsAt', type: 'uint64' },
  ] },
  { type: 'event', name: 'AuctionSold', anonymous: false, inputs: [
    { indexed: true, name: 'auctionId', type: 'uint256' }, { indexed: true, name: 'buyer', type: 'address' },
    { indexed: false, name: 'price', type: 'uint256' },
  ] },
  { type: 'event', name: 'AuctionFailed', anonymous: false, inputs: [{ indexed: true, name: 'auctionId', type: 'uint256' }] },
] as const;

export const settlementEscrowV2Abi = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [
    { name: 'claimId', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [] },
  { type: 'event', name: 'ClaimRecorded', anonymous: false, inputs: [
    { indexed: true, name: 'claimId', type: 'uint256' }, { indexed: true, name: 'beneficiary', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' }, { indexed: true, name: 'claimReference', type: 'bytes32' },
  ] },
  { type: 'event', name: 'ClaimWithdrawn', anonymous: false, inputs: [
    { indexed: true, name: 'claimId', type: 'uint256' }, { indexed: true, name: 'beneficiary', type: 'address' },
    { indexed: true, name: 'recipient', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: false, name: 'remaining', type: 'uint256' },
  ] },
] as const;

export const signedValuationOracleAbi = [
  { type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [
    { name: 'attestation', type: 'tuple', components: [
      { name: 'asset', type: 'address' }, { name: 'settlementToken', type: 'address' },
      { name: 'priceE18', type: 'uint256' }, { name: 'observedAt', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
      { name: 'evidenceHash', type: 'bytes32' },
    ] },
    { name: 'signatures', type: 'bytes[]' },
  ], outputs: [{ name: 'digest', type: 'bytes32' }] },
  { type: 'function', name: 'latest', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [
    { name: 'valuation', type: 'tuple', components: [
      { name: 'priceE18', type: 'uint256' }, { name: 'observedAt', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
      { name: 'digest', type: 'bytes32' }, { name: 'settlementToken', type: 'address' },
      { name: 'evidenceHash', type: 'bytes32' },
    ] },
  ] },
  { type: 'function', name: 'signerSet', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address[3]' }] },
  { type: 'function', name: 'lastNonce', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: 'nonce', type: 'uint256' }] },
  { type: 'function', name: 'nonceUnavailable', stateMutability: 'view', inputs: [
    { name: 'asset', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ], outputs: [{ name: 'unavailable', type: 'bool' }] },
  { type: 'function', name: 'hashAttestation', stateMutability: 'view', inputs: [
    { name: 'attestation', type: 'tuple', components: [
      { name: 'asset', type: 'address' }, { name: 'settlementToken', type: 'address' },
      { name: 'priceE18', type: 'uint256' }, { name: 'observedAt', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
      { name: 'evidenceHash', type: 'bytes32' },
    ] },
  ], outputs: [{ name: 'digest', type: 'bytes32' }] },
  { type: 'event', name: 'ValuationAccepted', anonymous: false, inputs: [
    { indexed: true, name: 'asset', type: 'address' }, { indexed: false, name: 'priceE18', type: 'uint256' },
    { indexed: false, name: 'observedAt', type: 'uint64' }, { indexed: false, name: 'validUntil', type: 'uint64' },
    { indexed: true, name: 'nonce', type: 'uint256' }, { indexed: true, name: 'digest', type: 'bytes32' },
    { indexed: false, name: 'settlementToken', type: 'address' }, { indexed: false, name: 'evidenceHash', type: 'bytes32' },
  ] },
  { type: 'event', name: 'ValuationInvalidated', anonymous: false, inputs: [
    { indexed: true, name: 'asset', type: 'address' }, { indexed: true, name: 'nonce', type: 'uint256' },
    { indexed: true, name: 'digest', type: 'bytes32' },
  ] },
] as const;

export const riskManagerV2Abi = [
  { type: 'event', name: 'ConfigApplied', anonymous: false, inputs: [
    { indexed: true, name: 'asset', type: 'address' }, { indexed: true, name: 'configHash', type: 'bytes32' },
    { indexed: false, name: 'config', type: 'tuple', components: [
      { name: 'enabled', type: 'bool' }, { name: 'initialLtvBps', type: 'uint16' },
      { name: 'maintenanceLtvBps', type: 'uint16' }, { name: 'liquidationLtvBps', type: 'uint16' },
      { name: 'auctionStartBps', type: 'uint16' }, { name: 'auctionFloorBps', type: 'uint16' },
      { name: 'liquidationFeeBps', type: 'uint16' }, { name: 'earlyMinHoldBps', type: 'uint16' },
      { name: 'earlyBreakFeeBps', type: 'uint16' }, { name: 'defaultSpreadBps', type: 'uint32' },
      { name: 'maxDefaultRateBps', type: 'uint32' }, { name: 'maxOracleAge', type: 'uint64' },
      { name: 'auctionDuration', type: 'uint64' }, { name: 'marginCallPeriod', type: 'uint64' },
      { name: 'staleOracleFallbackDelay', type: 'uint64' },
    ] },
  ] },
  { type: 'event', name: 'ConfigScheduled', anonymous: false, inputs: [
    { indexed: true, name: 'asset', type: 'address' }, { indexed: true, name: 'configHash', type: 'bytes32' },
    { indexed: false, name: 'executeAfter', type: 'uint64' },
  ] },
  { type: 'event', name: 'ConfigCancelled', anonymous: false, inputs: [{ indexed: true, name: 'asset', type: 'address' }] },
] as const;

export const marginEngineV2Abi = [
  { type: 'function', name: 'depositCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawAvailable', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'openMarginAccount', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'collateralAmount', type: 'uint128' }, { name: 'fundingTarget', type: 'uint128' },
    { name: 'minimumFunding', type: 'uint128' }, { name: 'maxAnnualRateBps', type: 'uint32' },
    { name: 'duration', type: 'uint64' }, { name: 'fundingExpiry', type: 'uint64' },
    { name: 'permittedLender', type: 'address' },
  ] }], outputs: [{ name: 'accountId', type: 'uint256' }] },
  { type: 'function', name: 'addMarginCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }, { name: 'amount', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'withdrawExcessCollateral', stateMutability: 'nonpayable', inputs: [
    { name: 'accountId', type: 'uint256' }, { name: 'amount', type: 'uint128' }, { name: 'recipient', type: 'address' },
  ], outputs: [] },
  { type: 'function', name: 'fundMarginAccount', stateMutability: 'nonpayable', inputs: [
    { name: 'accountId', type: 'uint256' }, { name: 'principal', type: 'uint128' },
    { name: 'annualRateBps', type: 'uint32' }, { name: 'maxFee', type: 'uint256' },
  ], outputs: [{ name: 'exposureId', type: 'uint256' }] },
  { type: 'function', name: 'closeFunding', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'repayExposure', stateMutability: 'nonpayable', inputs: [
    { name: 'exposureId', type: 'uint256' }, { name: 'maxFaceDebt', type: 'uint256' }, { name: 'useEscrow', type: 'bool' },
  ], outputs: [] },
  { type: 'function', name: 'declarePaymentDefault', stateMutability: 'nonpayable', inputs: [{ name: 'exposureId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'openMarginCall', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cureMarginCall', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'startMarginLiquidation', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [{ name: 'auctionId', type: 'uint256' }] },
  { type: 'function', name: 'buyMarginAuction', stateMutability: 'nonpayable', inputs: [{ name: 'auctionId', type: 'uint256' }, { name: 'maxPrice', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'finalizeFailedMarginAuction', stateMutability: 'nonpayable', inputs: [{ name: 'auctionId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'startInKindOracleFallback', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'materializeLiquidationClaim', stateMutability: 'nonpayable', inputs: [{ name: 'exposureId', type: 'uint256' }], outputs: [{ name: 'claimId', type: 'uint256' }] },
  { type: 'function', name: 'claimFailedCollateral', stateMutability: 'nonpayable', inputs: [{ name: 'exposureId', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'closeMarginAccount', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'accountLtv', stateMutability: 'view', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getAccount', stateMutability: 'view', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [
    { name: '', type: 'tuple', components: [
      { name: 'seller', type: 'address' }, { name: 'permittedLender', type: 'address' },
      { name: 'collateralAmount', type: 'uint128' }, { name: 'fundingTarget', type: 'uint128' },
      { name: 'minimumFunding', type: 'uint128' },
      { name: 'totalFunded', type: 'uint128' }, { name: 'totalFaceDebt', type: 'uint128' },
      { name: 'feeCharged', type: 'uint128' }, { name: 'frozenDebt', type: 'uint128' },
      { name: 'liquidationProceeds', type: 'uint128' }, { name: 'remainingProceeds', type: 'uint128' },
      { name: 'remainingCollateral', type: 'uint128' }, { name: 'marginCallDeadline', type: 'uint64' },
      { name: 'defaultDeclaredAt', type: 'uint64' }, { name: 'fundingDuration', type: 'uint64' },
      { name: 'fundingExpiry', type: 'uint64' }, { name: 'maxOracleAge', type: 'uint64' },
      { name: 'auctionDuration', type: 'uint64' }, { name: 'marginCallPeriod', type: 'uint64' },
      { name: 'staleOracleFallbackDelay', type: 'uint64' }, { name: 'activeExposureCount', type: 'uint32' },
      { name: 'unclaimedExposureCount', type: 'uint32' }, { name: 'maxAnnualRateBps', type: 'uint32' },
      { name: 'initialLtvBps', type: 'uint16' },
      { name: 'maintenanceLtvBps', type: 'uint16' }, { name: 'liquidationLtvBps', type: 'uint16' },
      { name: 'auctionStartBps', type: 'uint16' }, { name: 'auctionFloorBps', type: 'uint16' },
      { name: 'liquidationFeeBps', type: 'uint16' }, { name: 'paymentDefaultDeclared', type: 'bool' },
      { name: 'inKindCloseout', type: 'bool' }, { name: 'fundingClosed', type: 'bool' },
      { name: 'status', type: 'uint8' },
      { name: 'auctionId', type: 'uint256' }, { name: 'claimPoolId', type: 'uint256' },
      { name: 'closeoutValuationDigest', type: 'bytes32' },
    ] },
  ] },
  { type: 'function', name: 'getExposure', stateMutability: 'view', inputs: [{ name: 'exposureId', type: 'uint256' }], outputs: [
    { name: '', type: 'tuple', components: [
      { name: 'accountId', type: 'uint256' }, { name: 'lender', type: 'address' },
      { name: 'principal', type: 'uint128' }, { name: 'faceDebt', type: 'uint128' },
      { name: 'openedAt', type: 'uint64' }, { name: 'maturity', type: 'uint64' }, { name: 'status', type: 'uint8' },
    ] },
  ] },
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'settlementToken', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'auctionHouse', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'settlementEscrow', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'feeTreasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'protocolFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'gracePeriod', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'cleanverseCustodyReady', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'entryPaused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'event', name: 'MarginCollateralDeposited', anonymous: false, inputs: [
    { indexed: true, name: 'seller', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginCollateralWithdrawn', anonymous: false, inputs: [
    { indexed: true, name: 'seller', type: 'address' }, { indexed: true, name: 'recipient', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginAccountOpened', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'seller', type: 'address' },
    { indexed: false, name: 'collateralAmount', type: 'uint256' },
    { indexed: false, name: 'fundingTarget', type: 'uint256' },
    { indexed: false, name: 'minimumFunding', type: 'uint256' },
    { indexed: false, name: 'maxAnnualRateBps', type: 'uint256' },
    { indexed: false, name: 'duration', type: 'uint256' },
    { indexed: false, name: 'fundingExpiry', type: 'uint256' },
    { indexed: false, name: 'permittedLender', type: 'address' },
  ] },
  { type: 'event', name: 'FundingMandateClosed', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' },
    { indexed: false, name: 'fundedPrincipal', type: 'uint256' },
    { indexed: false, name: 'unfilledPrincipal', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginCollateralAdded', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: false, name: 'collateralAfter', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginCollateralReleased', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: false, name: 'collateralAfter', type: 'uint256' },
  ] },
  { type: 'event', name: 'ExposureFunded', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'exposureId', type: 'uint256' },
    { indexed: true, name: 'lender', type: 'address' }, { indexed: false, name: 'principal', type: 'uint256' },
    { indexed: false, name: 'faceDebt', type: 'uint256' }, { indexed: false, name: 'fee', type: 'uint256' },
    { indexed: false, name: 'annualRateBps', type: 'uint256' },
    { indexed: false, name: 'duration', type: 'uint256' },
    { indexed: false, name: 'openedAt', type: 'uint256' },
    { indexed: false, name: 'maturity', type: 'uint256' },
  ] },
  { type: 'event', name: 'ExposureRepaid', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'exposureId', type: 'uint256' },
    { indexed: true, name: 'lender', type: 'address' }, { indexed: false, name: 'faceDebt', type: 'uint256' },
    { indexed: false, name: 'escrowed', type: 'bool' }, { indexed: false, name: 'claimId', type: 'uint256' },
  ] },
  { type: 'event', name: 'PaymentDefaultDeclared', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'exposureId', type: 'uint256' },
    { indexed: false, name: 'declaredAt', type: 'uint64' },
  ] },
  { type: 'event', name: 'MarginCallOpened', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: false, name: 'ltvBps', type: 'uint256' },
    { indexed: false, name: 'cureDeadline', type: 'uint64' },
  ] },
  { type: 'event', name: 'MarginCallCured', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: false, name: 'ltvBps', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginLiquidationStarted', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'auctionId', type: 'uint256' },
    { indexed: false, name: 'frozenDebt', type: 'uint256' }, { indexed: false, name: 'collateral', type: 'uint256' },
    { indexed: true, name: 'valuationDigest', type: 'bytes32' },
  ] },
  { type: 'event', name: 'MarginLiquidated', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'auctionId', type: 'uint256' },
    { indexed: true, name: 'buyer', type: 'address' }, { indexed: false, name: 'price', type: 'uint256' },
    { indexed: false, name: 'lenderPool', type: 'uint256' }, { indexed: false, name: 'fee', type: 'uint256' },
    { indexed: false, name: 'sellerSurplus', type: 'uint256' }, { indexed: false, name: 'shortfall', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginAuctionFailed', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'auctionId', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginInKindCloseoutStarted', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'claimPoolId', type: 'uint256' },
  ] },
  { type: 'event', name: 'LiquidationProceedsMaterialized', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'exposureId', type: 'uint256' },
    { indexed: true, name: 'lender', type: 'address' }, { indexed: false, name: 'claimId', type: 'uint256' },
    { indexed: false, name: 'amount', type: 'uint256' },
  ] },
  { type: 'event', name: 'LiquidationCollateralClaimed', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: true, name: 'exposureId', type: 'uint256' },
    { indexed: true, name: 'lender', type: 'address' }, { indexed: false, name: 'recipient', type: 'address' },
    { indexed: false, name: 'amount', type: 'uint256' },
  ] },
  { type: 'event', name: 'MarginAccountClosed', anonymous: false, inputs: [
    { indexed: true, name: 'accountId', type: 'uint256' }, { indexed: false, name: 'collateralReleased', type: 'uint256' },
  ] },
  { type: 'event', name: 'SettlementEscrowed', anonymous: false, inputs: [
    { indexed: true, name: 'beneficiary', type: 'address' }, { indexed: true, name: 'claimId', type: 'uint256' },
    { indexed: false, name: 'amount', type: 'uint256' }, { indexed: true, name: 'claimReference', type: 'bytes32' },
  ] },
] as const;

export const v2AbiByModule = {
  REPO_MARKET: repoMarketV2Abi,
  COLLATERAL_VAULT: collateralVaultV2Abi,
  SETTLEMENT_ESCROW: settlementEscrowV2Abi,
  VALUATION_ORACLE: signedValuationOracleAbi,
  RISK_MANAGER: riskManagerV2Abi,
  DUTCH_AUCTION: dutchAuctionV2Abi,
  MARGIN_ENGINE: marginEngineV2Abi,
} as const;
