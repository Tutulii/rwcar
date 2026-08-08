import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const address = (name) => {
  const value = required(name);
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return value;
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(packageRoot, 'artifacts-solc', `${name}.json`), 'utf8'));
const chain = defineChain({
  id: 10_143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz'] } },
});
const account = privateKeyToAccount(required('UAT_DEPLOYER_PRIVATE_KEY'));
const owner = address('UAT_OWNER_ADDRESS');
const treasury = address('FEE_TREASURY_ADDRESS');
const cva = address('CVA_ASSET_ADDRESS');
const settlement = process.env.SETTLEMENT_TOKEN_ADDRESS || '0xaC0893567D43C3E7e6e35a72803df05416C1f20D';
const validator = process.env.COMPLIANCE_VALIDATOR_ADDRESS || '0xaC7e5179C2C7f03f209136886c172eb34F161792';
const referenceHash = required('CVA_REFERENCE_HASH');
if (!/^0x[a-fA-F0-9]{64}$/.test(referenceHash)) throw new Error('CVA_REFERENCE_HASH must be bytes32');
if (account.address.toLowerCase() === '0x911f99f424d47f08a15fcc771e94dcc2f7252b02') {
  throw new Error('Refusing to deploy from the previously exposed demo issuer wallet. Use a fresh UAT deployer.');
}
if (owner.toLowerCase() === account.address.toLowerCase()) {
  throw new Error('UAT_OWNER_ADDRESS must be separate from the deployer for two-step ownership handoff.');
}

const transport = http(chain.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 3 });
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

async function deploy(name, args) {
  const compiled = artifact(name);
  const hash = await walletClient.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed: ${hash}`);
  return { address: receipt.contractAddress, abi: compiled.abi, txHash: hash, blockNumber: receipt.blockNumber };
}

async function write(contract, functionName, args) {
  const simulation = await publicClient.simulateContract({
    account,
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== 'success') throw new Error(`${functionName} failed: ${hash}`);
  return hash;
}

const registry = await deploy('CvaAssetRegistry', [account.address]);
await write(registry, 'setAsset', [cva, true, 6, referenceHash]);
const market = await deploy('RepoMarketV1', [
  account.address,
  settlement,
  validator,
  registry.address,
  treasury,
  15,
  120,
  [300],
]);
await write(registry, 'transferOwnership', [owner]);
await write(market, 'transferOwnership', [owner]);

console.log(JSON.stringify({
  chainId: chain.id,
  deployer: account.address,
  pendingOwner: owner,
  assetRegistry: registry.address,
  repoMarket: market.address,
  deploymentBlock: market.blockNumber.toString(),
  settlementToken: settlement,
  validator,
  cva,
  requiredNextSteps: [
    'The pending owner must call acceptOwnership on both contracts.',
    'Register RepoMarketV1 as a Cleanverse compliance pool and configure its rule through the Cleanverse API.',
    'Set REPO_MARKET_ADDRESS, ASSET_REGISTRY_ADDRESS, and REPO_MARKET_DEPLOYMENT_BLOCK in the services.',
  ],
}, null, 2));
