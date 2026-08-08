import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, defineChain } from 'viem';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = (name) => JSON.parse(readFileSync(join(root, 'artifacts-solc', `${name}.json`), 'utf8'));
const chain = defineChain({
  id: 31_337, name: 'Ganache', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

test('CollateralVaultV2 rejects non-exact outgoing CVA transfers without changing liabilities', async () => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { chainId: chain.id }, wallet: { deterministic: true } });
  const addresses = await provider.request({ method: 'eth_accounts', params: [] });
  const [controller, seller] = addresses.map((account) => createWalletClient({ account, chain, transport: custom(provider) }));
  const publicClient = createPublicClient({ chain, transport: custom(provider) });
  const wait = async (hash, expected = 'success') => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, expected);
    return receipt;
  };
  const deploy = async (name, args = []) => {
    const compiled = artifact(name);
    const result = await wait(await controller.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args, gas: 8_000_000n }));
    return { address: result.contractAddress, abi: compiled.abi };
  };
  const token = await deploy('MockFeeOnTransferERC20', [100]);
  const vault = await deploy('CollateralVaultV2', [controller.account.address, token.address]);
  const write = (wallet, contract, functionName, args = []) => wallet.writeContract({
    address: contract.address, abi: contract.abi, functionName, args, gas: 8_000_000n,
  });
  const read = (contract, functionName, args = []) => publicClient.readContract({
    address: contract.address, abi: contract.abi, functionName, args,
  });

  await wait(await write(controller, token, 'mint', [seller.account.address, 1_000_000n]));
  await wait(await write(seller, token, 'approve', [vault.address, 1_000_000n]));
  await wait(await write(controller, vault, 'depositFor', [seller.account.address, 1_000_000n]));
  await wait(await write(controller, token, 'setFeeEnabled', [true]));
  await wait(await write(controller, vault, 'withdrawTo', [seller.account.address, seller.account.address, 1_000_000n]), 'reverted');

  assert.equal(await read(vault, 'totalAccounted'), 1_000_000n);
  assert.equal(await read(vault, 'availableBalance', [seller.account.address]), 1_000_000n);
  assert.equal(await read(token, 'balanceOf', [vault.address]), 1_000_000n);
  assert.equal(await read(vault, 'isSolvent'), true);
});
