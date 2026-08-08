import { createPublicClient, defineChain, encodeFunctionData, http, keccak256, parseAbi } from 'viem';

export const MONAD_CHAIN_ID = 10143;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const marketAbi = parseAbi([
  'function createOffer(address asset,uint128 collateralAmount,uint128 principalAmount,uint32 annualRateBps,uint64 duration,uint64 offerExpiry,address permittedBuyer,bytes32 valuationHash) returns (uint256)',
  'function cancelOffer(uint256 repoId)',
  'function expireOffer(uint256 repoId)',
  'function acceptOffer(uint256 repoId)',
  'function repurchase(uint256 repoId)',
  'function markDefault(uint256 repoId)',
]);

const erc20Abi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const marketReadAbi = parseAbi([
  'function getRepo(uint256 repoId) view returns ((address seller,address buyer,address permittedBuyer,address asset,uint128 collateralAmount,uint128 principalAmount,uint128 repurchaseAmount,uint32 annualRateBps,uint64 duration,uint64 offerExpiry,uint64 acceptedAt,uint64 maturity,uint64 repaymentDeadline,bytes32 valuationHash,uint8 status))',
]);
const ownershipAbi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
]);

const monadTestnet = defineChain({
  id: MONAD_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
});
const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });

export class SubmittedTransactionError extends Error {
  constructor(message, { code, txHash, confirmed = false } = {}) {
    super(message);
    this.name = 'SubmittedTransactionError';
    this.code = code;
    this.txHash = txHash;
    this.submitted = true;
    this.confirmed = confirmed;
  }
}

export async function readRuntimeCodeHash(address) {
  const bytecode = await publicClient.getBytecode({ address });
  if (!bytecode || bytecode === '0x') throw new Error(`No runtime code exists at ${address}.`);
  return keccak256(bytecode);
}

export async function readTransactionStatus(hash) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return { status: receipt.status === 'success' ? 'success' : 'reverted', receipt };
  } catch {
    return { status: 'pending', receipt: null };
  }
}

export function encodeApproval(spender, amount) {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, BigInt(amount)] });
}

export function encodeMarketCall(functionName, args) {
  return encodeFunctionData({ abi: marketAbi, functionName, args });
}

export function encodeAcceptOwnership() {
  return encodeFunctionData({ abi: ownershipAbi, functionName: 'acceptOwnership' });
}

export async function readOwnership(contract) {
  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({ address: contract, abi: ownershipAbi, functionName: 'owner' }),
    publicClient.readContract({ address: contract, abi: ownershipAbi, functionName: 'pendingOwner' }),
  ]);
  return { owner, pendingOwner };
}

export async function readRepoState(contract, repoId) {
  const [repo, block] = await Promise.all([
    publicClient.readContract({ address: contract, abi: marketReadAbi, functionName: 'getRepo', args: [BigInt(repoId)] }),
    publicClient.getBlock(),
  ]);
  const statusNames = ['NONE', 'OPEN', 'ACTIVE', 'REPAID', 'CANCELLED', 'EXPIRED', 'DEFAULTED'];
  return {
    status: Number(repo.status),
    statusName: statusNames[Number(repo.status)] || 'UNKNOWN',
    offerExpiry: Number(repo.offerExpiry),
    chainTimestamp: Number(block.timestamp),
  };
}

export async function sendTransaction(wallet, to, data, { onSubmitted, value, expectedFrom } = {}) {
  if (!wallet) throw new Error('Connect a wallet before continuing.');
  if (expectedFrom && wallet.address?.toLowerCase() !== expectedFrom.toLowerCase()) {
    throw new Error('The active signer changed after preflight. Review the action with the connected wallet again.');
  }
  await wallet.switchChain(MONAD_CHAIN_ID);
  const provider = await wallet.getEthereumProvider();
  const liveChainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
  if (liveChainId !== MONAD_CHAIN_ID) throw new Error(`Switch the wallet to Monad Testnet (${MONAD_CHAIN_ID}) before signing.`);
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: wallet.address, to, data, ...(value && value !== '0' ? { value: `0x${BigInt(value).toString(16)}` } : {}) }],
  });
  try {
    onSubmitted?.(hash);
  } catch (reason) {
    throw new SubmittedTransactionError(
      `Transaction ${hash} was submitted, but its recovery record could not be stored. Keep this hash and do not submit the action again.`,
      { code: 'RECOVERY_PERSIST_FAILED', txHash: hash },
    );
  }
  let lastReceiptError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    let receipt;
    try {
      receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    } catch (reason) {
      lastReceiptError = reason;
    }
    if (receipt) {
      if (receipt.status !== '0x1') {
        throw new SubmittedTransactionError('The Monad transaction reverted.', { code: 'TX_REVERTED', txHash: hash, confirmed: true });
      }
      return { hash, receipt };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new SubmittedTransactionError(
    `Transaction ${hash} was submitted, but its receipt is still unknown. Do not submit it again.`,
    { code: lastReceiptError ? 'RECEIPT_RPC_UNAVAILABLE' : 'TX_STATUS_UNKNOWN', txHash: hash },
  );
}

export function parseUnits(value, decimals = 6) {
  const normalized = String(value).replaceAll(',', '').trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a valid token amount.');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
}

export function formatUnits(value, decimals = 6, maximumFractionDigits = 2) {
  const atomic = BigInt(value || 0);
  const negative = atomic < 0n;
  const absolute = negative ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const whole = decimals === 0 ? absolute : absolute / scale;
  const groupedWhole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(whole);
  const shownDecimals = Math.max(0, Math.min(Number(decimals), Number(maximumFractionDigits)));
  if (shownDecimals === 0 || decimals === 0) return `${negative ? '-' : ''}${groupedWhole}`;
  const fraction = (absolute % scale)
    .toString()
    .padStart(Number(decimals), '0')
    .slice(0, shownDecimals)
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${groupedWhole}${fraction ? `.${fraction}` : ''}`;
}
