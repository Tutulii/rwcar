export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export const repoMarketAbi = [
  { type: 'function', name: 'createOffer', stateMutability: 'nonpayable', inputs: [
    { name: 'asset', type: 'address' },
    { name: 'collateralAmount', type: 'uint128' },
    { name: 'principalAmount', type: 'uint128' },
    { name: 'annualRateBps', type: 'uint32' },
    { name: 'duration', type: 'uint64' },
    { name: 'offerExpiry', type: 'uint64' },
    { name: 'permittedBuyer', type: 'address' },
    { name: 'valuationHash', type: 'bytes32' },
  ], outputs: [{ name: 'repoId', type: 'uint256' }] },
  { type: 'function', name: 'cancelOffer', stateMutability: 'nonpayable', inputs: [{ name: 'repoId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'acceptOffer', stateMutability: 'nonpayable', inputs: [{ name: 'repoId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'repurchase', stateMutability: 'nonpayable', inputs: [{ name: 'repoId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'markDefault', stateMutability: 'nonpayable', inputs: [{ name: 'repoId', type: 'uint256' }], outputs: [] },
] as const;
