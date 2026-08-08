import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseAbi,
  stringToHex,
} from 'viem';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(root, 'artifacts-solc', `${name}.json`), 'utf8'));
const referenceHash = keccak256(stringToHex('IA20260805120745190158'));
const valuationHash = keccak256(stringToHex('RWRN01-VALUATION-UAT-001'));
const duration = 300;
const grace = 120;
const principal = 20_000n;
const collateral = 1_000_000n;
const testChain = defineChain({
  id: 31_337,
  name: 'Ganache',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

async function wait(publicClient, hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}

async function expectRevert(publicClient, send) {
  const hash = await send();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'reverted');
}

describe('RepoMarketV1', () => {
  let provider;
  let publicClient;
  let wallets;
  let accounts;
  let owner;
  let seller;
  let buyer;
  let outsider;
  let treasury;
  let validator;
  let settlement;
  let asset;
  let registry;
  let market;

  beforeEach(async () => {
    provider = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 31_337 },
      wallet: { deterministic: true, totalAccounts: 6 },
    });
    accounts = await provider.request({ method: 'eth_accounts', params: [] });
    wallets = accounts.map((account) => createWalletClient({ account, chain: testChain, transport: custom(provider) }));
    [owner, seller, buyer, outsider, treasury] = wallets;
    publicClient = createPublicClient({ chain: testChain, transport: custom(provider) });

    const deploy = async (name, args = []) => {
      const compiled = artifact(name);
      const hash = await owner.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args, gas: 8_000_000n });
      const receipt = await wait(publicClient, hash);
      return { address: receipt.contractAddress, abi: compiled.abi };
    };

    validator = await deploy('MockComplianceValidator');
    settlement = await deploy('MockERC20', ['Access USDC', 'aUSDC', 6]);
    asset = await deploy('MockERC20', ['RWCAR Receivable Note I', 'RWRN01', 6]);
    registry = await deploy('CvaAssetRegistry', [owner.account.address]);
    market = await deploy('RepoMarketV1', [
      owner.account.address,
      settlement.address,
      validator.address,
      registry.address,
      treasury.account.address,
      15,
      grace,
      [duration],
    ]);

    await wait(publicClient, await owner.writeContract({
      address: registry.address,
      abi: registry.abi,
      functionName: 'setAsset',
      args: [asset.address, true, 6, referenceHash],
      gas: 8_000_000n,
    }));

    for (const wallet of [seller, buyer, treasury]) {
      await wait(publicClient, await owner.writeContract({
        address: validator.address,
        abi: validator.abi,
        functionName: 'setCompliant',
        args: [wallet.account.address, true],
        gas: 8_000_000n,
      }));
    }

    await wait(publicClient, await owner.writeContract({
      address: asset.address,
      abi: asset.abi,
      functionName: 'mint',
      args: [seller.account.address, 100_000_000n],
      gas: 8_000_000n,
    }));
    await wait(publicClient, await owner.writeContract({
      address: settlement.address,
      abi: settlement.abi,
      functionName: 'mint',
      args: [buyer.account.address, 1_000_000n],
      gas: 8_000_000n,
    }));
    await wait(publicClient, await owner.writeContract({
      address: settlement.address,
      abi: settlement.abi,
      functionName: 'mint',
      args: [seller.account.address, 1_000_000n],
      gas: 8_000_000n,
    }));

    const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
    for (const [wallet, token, amount] of [
      [seller, asset, 100_000_000n],
      [seller, settlement, 1_000_000n],
      [buyer, settlement, 1_000_000n],
      [buyer, asset, 100_000_000n],
    ]) {
      await wait(publicClient, await wallet.writeContract({
        address: token.address,
        abi: approvalAbi,
        functionName: 'approve',
        args: [market.address, amount],
        gas: 8_000_000n,
      }));
    }
  });

  async function createOffer(permittedBuyer = '0x0000000000000000000000000000000000000000') {
    const block = await publicClient.getBlock();
    const hash = await seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'createOffer',
      args: [asset.address, collateral, principal, 575, duration, Number(block.timestamp) + 3600, permittedBuyer, valuationHash],
      gas: 8_000_000n,
    });
    await wait(publicClient, hash);
    return 1n;
  }

  it('opens and atomically repurchases a compliant repo', async () => {
    const repoId = await createOffer();
    await wait(publicClient, await buyer.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'acceptOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));

    const readBalance = (token, account) => publicClient.readContract({
      address: token.address,
      abi: token.abi,
      functionName: 'balanceOf',
      args: [account],
    });
    assert.equal(await readBalance(asset, buyer.account.address), collateral);
    assert.equal(await readBalance(settlement, treasury.account.address), 30n);

    const repo = await publicClient.readContract({
      address: market.address,
      abi: market.abi,
      functionName: 'getRepo',
      args: [repoId],
    });
    assert.equal(repo.status, 2);
    assert.equal(repo.repurchaseAmount, 20_001n);

    await provider.request({ method: 'evm_increaseTime', params: [duration + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await wait(publicClient, await seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'repurchase',
      args: [repoId],
      gas: 8_000_000n,
    }));

    const closed = await publicClient.readContract({
      address: market.address,
      abi: market.abi,
      functionName: 'getRepo',
      args: [repoId],
    });
    assert.equal(closed.status, 3);
    assert.equal(await readBalance(asset, seller.account.address), 100_000_000n);
  });

  it('enforces targeted buyers', async () => {
    const repoId = await createOffer(outsider.account.address);
    await expectRevert(publicClient, () => buyer.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'acceptOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));
  });

  it('allows permissionless default only after maturity and grace', async () => {
    const repoId = await createOffer();
    await wait(publicClient, await buyer.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'acceptOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));
    await expectRevert(publicClient, () => outsider.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'markDefault',
      args: [repoId],
      gas: 8_000_000n,
    }));
    await provider.request({ method: 'evm_increaseTime', params: [duration + grace + 1] });
    await provider.request({ method: 'evm_mine', params: [] });
    await wait(publicClient, await outsider.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'markDefault',
      args: [repoId],
      gas: 8_000_000n,
    }));
    const repo = await publicClient.readContract({
      address: market.address,
      abi: market.abi,
      functionName: 'getRepo',
      args: [repoId],
    });
    assert.equal(repo.status, 6);
  });

  it('pauses entry without disabling cancellation', async () => {
    const repoId = await createOffer();
    await wait(publicClient, await owner.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'setEntryPaused',
      args: [true],
      gas: 8_000_000n,
    }));
    await expectRevert(publicClient, () => buyer.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'acceptOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));
    await wait(publicClient, await seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'cancelOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));
  });

  it('fails closed when the seller loses compliance', async () => {
    await wait(publicClient, await owner.writeContract({
      address: validator.address,
      abi: validator.abi,
      functionName: 'setCompliant',
      args: [seller.account.address, false],
      gas: 8_000_000n,
    }));
    const block = await publicClient.getBlock();
    await expectRevert(publicClient, () => seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'createOffer',
      args: [asset.address, collateral, principal, 575, duration, Number(block.timestamp) + 3600, '0x0000000000000000000000000000000000000000', valuationHash],
      gas: 8_000_000n,
    }));
  });

  it('does not allow repurchase before maturity', async () => {
    const repoId = await createOffer();
    await wait(publicClient, await buyer.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'acceptOffer',
      args: [repoId],
      gas: 8_000_000n,
    }));
    await expectRevert(publicClient, () => seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'repurchase',
      args: [repoId],
      gas: 8_000_000n,
    }));
  });

  it('allows anyone to expire an unfilled offer after its deadline', async () => {
    const block = await publicClient.getBlock();
    await wait(publicClient, await seller.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'createOffer',
      args: [asset.address, collateral, principal, 575, duration, Number(block.timestamp) + 10, '0x0000000000000000000000000000000000000000', valuationHash],
      gas: 8_000_000n,
    }));
    await provider.request({ method: 'evm_increaseTime', params: [11] });
    await provider.request({ method: 'evm_mine', params: [] });
    await wait(publicClient, await outsider.writeContract({
      address: market.address,
      abi: market.abi,
      functionName: 'expireOffer',
      args: [1n],
      gas: 8_000_000n,
    }));
    const repo = await publicClient.readContract({
      address: market.address,
      abi: market.abi,
      functionName: 'getRepo',
      args: [1n],
    });
    assert.equal(repo.status, 5);
  });
});
