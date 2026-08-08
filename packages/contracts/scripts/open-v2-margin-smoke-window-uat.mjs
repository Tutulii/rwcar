import { createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONFIRMATION = 'OPEN_RWCAR_V2_MARGIN_UAT_SMOKE_WINDOW';
const CHAIN_ID = 10_143;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretsDirectory = join(repositoryRoot, '.secrets');
const deploymentPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.json');
const cleanversePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.cleanverse.json');
const governancePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.governance.json');
const oraclePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.oracle.json');
const isolatedWindowPath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.smoke-window.json');
const evidencePath = join(repositoryRoot, 'deployments', 'monad-testnet-v2-hackathon.margin-smoke-window.json');
const credentialsPath = join(secretsDirectory, 'cleanverse-uat.json');
const artifactsDirectory = join(repositoryRoot, 'packages/contracts/artifacts-solc');
const execute = process.argv.includes('--execute');

if (execute && !process.argv.includes(`--confirm=${CONFIRMATION}`)) {
  throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
}
if (execute) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Refusing to open the margin smoke window from a dirty worktree');
}
for (const path of [deploymentPath, cleanversePath, governancePath, oraclePath, isolatedWindowPath, credentialsPath]) {
  if (!existsSync(path)) throw new Error(`Required activation evidence is missing: ${path}`);
}
if ((statSync(credentialsPath).mode & 0o077) !== 0) throw new Error('Cleanverse credential permissions must be 0600');

const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const cleanverse = JSON.parse(readFileSync(cleanversePath, 'utf8'));
const governance = JSON.parse(readFileSync(governancePath, 'utf8'));
const oracleEvidence = JSON.parse(readFileSync(oraclePath, 'utf8'));
const isolatedWindow = JSON.parse(readFileSync(isolatedWindowPath, 'utf8'));
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
if (cleanverse.status !== 'CLEANVERSE_REGISTERED_SMOKE_PENDING') throw new Error('Cleanverse evidence is incomplete');
if (governance.status !== 'GOVERNANCE_FINALIZED_ENTRY_PAUSED') throw new Error('Governance evidence is incomplete');
if (oracleEvidence.status !== 'VALUATION_ACTIVE') throw new Error('Oracle evidence is incomplete');
if (isolatedWindow.status !== 'ISOLATED_SMOKE_WINDOW_OPEN') throw new Error('Isolated smoke window evidence is incomplete');

const artifact = (name) => JSON.parse(readFileSync(join(artifactsDirectory, `${name}.json`), 'utf8')).abi;
const marginAbi = artifact('MarginEngineV2');
const marketAbi = artifact('RepoMarketV2');
const riskAbi = artifact('RiskManagerV2');
const oracleAbi = artifact('SignedValuationOracle');
const factoryAbi = artifact('ProtocolModuleFactoryV2');
const vaultAbi = artifact('CollateralVaultV2');
const escrowAbi = artifact('SettlementEscrowV2');
const ownableAbi = parseAbi(['function owner() view returns (address)']);
const validatorAbi = parseAbi([
  'function isRegistered(address pool) view returns (bool)',
  'function complianceVerify(address pool,address user) view returns (bool)',
]);
const tokenAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const encryptedBundle = JSON.parse(readFileSync(join(secretsDirectory, 'v2-uat-roles.enc.json'), 'utf8'));
const wrappingKey = Buffer.from(readFileSync(join(secretsDirectory, 'v2-uat-roles.key'), 'utf8').trim(), 'base64');
const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(encryptedBundle.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encryptedBundle.authTag, 'base64'));
const privateKeys = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(encryptedBundle.ciphertext, 'base64')),
  decipher.final(),
]).toString('utf8')).privateKeys;
const ownerAccount = privateKeyToAccount(privateKeys.owner);
if (ownerAccount.address.toLowerCase() !== deployment.roles.pendingOwner.toLowerCase()) {
  throw new Error('Final owner signer mismatch');
}

const network = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || 'https://testnet-rpc.monad.xyz'] } },
});
const baseTransport = http(network.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 0 });
let rpcQueue = Promise.resolve();
const transport = (config) => {
  const inner = baseTransport(config);
  return {
    ...inner,
    request(args) {
      const request = rpcQueue.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try { return await inner.request(args); } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('requests limited') && !message.includes('-32011')) throw error;
            if (attempt === 5) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
          }
        }
        throw new Error('RPC retry loop exhausted');
      });
      rpcQueue = request.then(() => undefined, () => undefined);
      return request;
    },
  };
};
const publicClient = createPublicClient({ chain: network, transport });
const ownerWallet = createWalletClient({ account: ownerAccount, chain: network, transport });

const seller = process.env.V2_SMOKE_SELLER_ADDRESS?.trim() || '0x911F99f424D47F08a15fcC771e94dcc2f7252B02';
const lender = process.env.V2_SMOKE_BUYER_ADDRESS?.trim() || '0xF7100Bcc9B352f18b80018D7708177C3C04a128D';
const verifyApass = async (atoken, address) => {
  const response = await fetch(`${credentials.baseUrl}/verify_apass`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-id': credentials.apiId },
    body: JSON.stringify({ chain: 'monad', atoken, address }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== '0000' || Number(json.data?.code) !== 4) {
    throw new Error(`A-Pass verification failed for ${address} and ${atoken}`);
  }
  return 4;
};

const marginBindings = [
  { key: 'marginVault', token: deployment.externalContracts.cvaAsset, custody: deployment.contracts.marginVault },
  { key: 'marginSettlementEscrow', token: deployment.externalContracts.settlementToken, custody: deployment.contracts.marginSettlementEscrow },
];
const custodyRegistration = {};
for (const binding of marginBindings) {
  const registrationKey = keccak256(encodeAbiParameters(
    parseAbiParameters('address,address,address'),
    [deployment.contracts.marginEngine, binding.token, binding.custody],
  ));
  custodyRegistration[binding.key] = await publicClient.readContract({
    address: deployment.contracts.moduleFactory,
    abi: factoryAbi,
    functionName: 'custodyRegistered',
    args: [registrationKey],
  });
  if (!custodyRegistration[binding.key]) throw new Error(`${binding.key} registration is missing`);
}

const [
  marginOwner,
  marginPoolRegistered,
  sellerCompliant,
  lenderCompliant,
  riskConfig,
  freshPrice,
  marginPaused,
  marginReady,
  marketPaused,
  marketAsset,
  vaultSolvent,
  vaultAccounted,
  vaultTokenBalance,
  escrowClaims,
  escrowTokenBalance,
] = await Promise.all([
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: ownableAbi, functionName: 'owner' }),
  publicClient.readContract({ address: deployment.externalContracts.complianceValidator, abi: validatorAbi, functionName: 'isRegistered', args: [deployment.contracts.marginEngine] }),
  publicClient.readContract({ address: deployment.externalContracts.complianceValidator, abi: validatorAbi, functionName: 'complianceVerify', args: [deployment.contracts.marginEngine, seller] }),
  publicClient.readContract({ address: deployment.externalContracts.complianceValidator, abi: validatorAbi, functionName: 'complianceVerify', args: [deployment.contracts.marginEngine, lender] }),
  publicClient.readContract({ address: deployment.contracts.riskManager, abi: riskAbi, functionName: 'rawConfig', args: [deployment.externalContracts.cvaAsset] }),
  publicClient.readContract({ address: deployment.contracts.valuationOracle, abi: oracleAbi, functionName: 'freshPrice', args: [deployment.externalContracts.cvaAsset, deployment.externalContracts.settlementToken, deployment.parameters.riskConfig.maxOracleAge] }),
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'cleanverseCustodyReady' }),
  publicClient.readContract({ address: deployment.contracts.repoMarket, abi: marketAbi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: deployment.contracts.repoMarket, abi: marketAbi, functionName: 'getAssetConfig', args: [deployment.externalContracts.cvaAsset] }),
  publicClient.readContract({ address: deployment.contracts.marginVault, abi: vaultAbi, functionName: 'isSolvent' }),
  publicClient.readContract({ address: deployment.contracts.marginVault, abi: vaultAbi, functionName: 'totalAccounted' }),
  publicClient.readContract({ address: deployment.externalContracts.cvaAsset, abi: tokenAbi, functionName: 'balanceOf', args: [deployment.contracts.marginVault] }),
  publicClient.readContract({ address: deployment.contracts.marginSettlementEscrow, abi: escrowAbi, functionName: 'totalClaims' }),
  publicClient.readContract({ address: deployment.externalContracts.settlementToken, abi: tokenAbi, functionName: 'balanceOf', args: [deployment.contracts.marginSettlementEscrow] }),
]);
if (marginOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) throw new Error('Margin ownership is not finalized');
if (!marginPoolRegistered || !sellerCompliant || !lenderCompliant) throw new Error('Margin compliance preflight failed');
if (!riskConfig.enabled || BigInt(freshPrice[0]) === 0n) throw new Error('Risk or oracle activation is incomplete');
if (marketPaused || !(marketAsset.cleanverseReady ?? marketAsset[2])) throw new Error('Isolated market readiness regressed');
if (!marginPaused && !marginReady) throw new Error('Margin entry is open without custody readiness');
if (!vaultSolvent || BigInt(vaultTokenBalance) < BigInt(vaultAccounted)) throw new Error('Margin vault is insolvent');
if (BigInt(escrowTokenBalance) < BigInt(escrowClaims)) throw new Error('Margin escrow is insolvent');

const apassChecks = {};
for (const [key, atoken, address] of [
  ['sellerCva', deployment.externalContracts.cvaAsset, seller],
  ['sellerSettlement', deployment.externalContracts.settlementToken, seller],
  ['lenderCva', deployment.externalContracts.cvaAsset, lender],
  ['lenderSettlement', deployment.externalContracts.settlementToken, lender],
  ['marginVault', deployment.externalContracts.cvaAsset, deployment.contracts.marginVault],
  ['marginEscrow', deployment.externalContracts.settlementToken, deployment.contracts.marginSettlementEscrow],
  ['feeTreasury', deployment.externalContracts.settlementToken, deployment.roles.feeTreasury],
]) apassChecks[key] = await verifyApass(atoken, address);

const publicPlan = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  status: execute ? 'EXECUTING' : 'READY_NOT_SUBMITTED',
  chainId: CHAIN_ID,
  marginEngine: deployment.contracts.marginEngine,
  smokeParticipants: { seller, lender },
  marginPoolRegistered,
  custodyRegistration,
  apassChecks,
  riskEnabled: riskConfig.enabled,
  oraclePriceE18: freshPrice[0].toString(),
  preState: {
    marginPaused,
    marginReady,
    vaultSolvent,
    vaultAccounted: vaultAccounted.toString(),
    vaultTokenBalance: vaultTokenBalance.toString(),
    escrowClaims: escrowClaims.toString(),
    escrowTokenBalance: escrowTokenBalance.toString(),
  },
};
if (!execute) {
  console.log(JSON.stringify(publicPlan, null, 2));
  process.exit(0);
}

const transactions = {};
const send = async (stage, functionName, args) => {
  const simulation = await publicClient.simulateContract({
    account: ownerAccount,
    address: deployment.contracts.marginEngine,
    abi: marginAbi,
    functionName,
    args,
  });
  const hash = await ownerWallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${stage} reverted: ${hash}`);
  transactions[stage] = { txHash: hash, blockNumber: receipt.blockNumber.toString() };
};
if (!marginReady) await send('marginCustodyReady', 'setCleanverseCustodyReady', [true]);
if (marginPaused) await send('marginEntryUnpaused', 'setEntryPaused', [false]);

const [finalMarginPaused, finalMarginReady] = await Promise.all([
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'entryPaused' }),
  publicClient.readContract({ address: deployment.contracts.marginEngine, abi: marginAbi, functionName: 'cleanverseCustodyReady' }),
]);
if (finalMarginPaused || !finalMarginReady) throw new Error('Margin smoke window did not open');

const evidence = {
  ...publicPlan,
  status: 'MARGIN_SMOKE_WINDOW_OPEN',
  completedAt: new Date().toISOString(),
  transactions,
  postState: { marginPaused: finalMarginPaused, marginReady: finalMarginReady },
};
deployment.readiness.marginCustodyReadyTransaction = transactions.marginCustodyReady?.txHash
  ?? deployment.readiness.marginCustodyReadyTransaction;
deployment.readiness.marginEntryUnpausedTransaction = transactions.marginEntryUnpaused?.txHash
  ?? deployment.readiness.marginEntryUnpausedTransaction;
deployment.serviceConfiguration.V2_MARGIN_ENABLED = true;
deployment.serviceConfiguration.V2_MARGIN_POLICY_POOL_REGISTERED = true;
deployment.serviceConfiguration.V2_MARGIN_VAULT_CUSTODY_READY = true;
deployment.serviceConfiguration.V2_MARGIN_ESCROW_AUSDC_READY = true;
deployment.serviceConfiguration.V2_MARGIN_TREASURY_AUSDC_ELIGIBLE = true;
for (const [key, transaction] of Object.entries(transactions)) deployment.transactions[key] = transaction;
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  status: evidence.status,
  transactions,
  marginReady: true,
  marginEntryOpen: true,
  evidencePath,
}, null, 2));
