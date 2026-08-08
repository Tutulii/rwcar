import { MONAD_TESTNET, signedValuationOracleAbi } from '@rwcar/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { IndexerConfig, V2DeploymentSource } from './config.js';

const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'asset', type: 'address' },
    { name: 'settlementToken', type: 'address' },
    { name: 'priceE18', type: 'uint256' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const;

type OracleValuation = {
  priceE18: bigint;
  observedAt: bigint;
  validUntil: bigint;
  nonce: bigint;
  digest: Hex;
  settlementToken: Address;
  evidenceHash: Hex;
};

export function shouldPublishOracleHeartbeat(
  latestObservedAt: bigint,
  chainTimestamp: bigint,
  intervalSeconds: bigint,
) {
  return latestObservedAt === 0n || chainTimestamp >= latestObservedAt + intervalSeconds;
}

export function resolveOracleHeartbeatTargets(sources: V2DeploymentSource[]) {
  const oracles = sources.filter((source) => source.module === 'VALUATION_ORACLE');
  if (oracles.length !== 1) throw new Error('Oracle heartbeat requires exactly one VALUATION_ORACLE source');
  const assets = new Set(sources.flatMap((source) => {
    const asset = source.metadata.asset;
    return typeof asset === 'string' && /^0x[a-fA-F0-9]{40}$/.test(asset) ? [asset.toLowerCase()] : [];
  }));
  if (assets.size !== 1) throw new Error('Oracle heartbeat requires exactly one asset across V2 deployment metadata');
  return {
    oracle: oracles[0]!.address as Address,
    asset: [...assets][0]! as Address,
  };
}

export function buildOracleHeartbeatTypedData(
  oracle: Address,
  attestation: {
    asset: Address;
    settlementToken: Address;
    priceE18: bigint;
    observedAt: bigint;
    validUntil: bigint;
    nonce: bigint;
    evidenceHash: Hex;
  },
) {
  return {
    domain: {
      name: 'RWCAR Signed Valuation Oracle',
      version: '2',
      chainId: MONAD_TESTNET.id,
      verifyingContract: oracle,
    },
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation' as const,
    message: attestation,
  } as const;
}

export class V2OracleHeartbeat {
  private readonly broadcaster;
  private readonly signerAccounts;
  private readonly publicClient;
  private readonly walletClient;
  private readonly oracle: Address;
  private readonly asset: Address;
  private readonly settlementToken: Address;
  private readonly expectedPrice: bigint;
  private readonly expectedEvidenceHash: Hex;
  private running = false;
  private wakeWait: (() => void) | undefined;

  constructor(
    private readonly config: IndexerConfig,
    sources: V2DeploymentSource[],
  ) {
    if (!config.V2_ORACLE_HEARTBEAT_ENABLED) throw new Error('Oracle heartbeat is not enabled');
    if (
      !config.V2_SETTLEMENT_TOKEN_ADDRESS
        || !config.V2_ORACLE_HEARTBEAT_PRICE_E18
        || !config.V2_ORACLE_HEARTBEAT_EVIDENCE_HASH
        || !config.V2_ORACLE_SIGNER_1_PRIVATE_KEY
        || !config.V2_ORACLE_SIGNER_2_PRIVATE_KEY
    ) throw new Error('Oracle heartbeat configuration is incomplete');

    ({ oracle: this.oracle, asset: this.asset } = resolveOracleHeartbeatTargets(sources));
    this.settlementToken = config.V2_SETTLEMENT_TOKEN_ADDRESS as Address;
    this.expectedPrice = BigInt(config.V2_ORACLE_HEARTBEAT_PRICE_E18);
    this.expectedEvidenceHash = config.V2_ORACLE_HEARTBEAT_EVIDENCE_HASH as Hex;
    this.signerAccounts = [
      privateKeyToAccount(config.V2_ORACLE_SIGNER_1_PRIVATE_KEY as Hex),
      privateKeyToAccount(config.V2_ORACLE_SIGNER_2_PRIVATE_KEY as Hex),
    ] as const;
    if (this.signerAccounts[0].address.toLowerCase() === this.signerAccounts[1].address.toLowerCase()) {
      throw new Error('Oracle heartbeat requires two distinct signers');
    }
    // Keep oracle publication and lifecycle automation on independent account
    // nonce streams. The first authorized oracle signer pays heartbeat gas.
    this.broadcaster = this.signerAccounts[0];

    const chain = defineChain({
      id: MONAD_TESTNET.id,
      name: MONAD_TESTNET.name,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [config.MONAD_RPC_URL] } },
    });
    const transport = http(config.MONAD_RPC_URL, { timeout: 20_000, retryCount: 3 });
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.broadcaster, chain, transport });
  }

  stop() {
    this.running = false;
    this.wakeWait?.();
  }

  private wait(milliseconds: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWait = undefined;
        resolve();
      }, milliseconds);
      this.wakeWait = () => {
        clearTimeout(timer);
        this.wakeWait = undefined;
        resolve();
      };
    });
  }

  private assertHeartbeatBaseline(valuation: OracleValuation) {
    if (valuation.digest === `0x${'0'.repeat(64)}` || valuation.observedAt === 0n) {
      throw new Error('Oracle heartbeat cannot bootstrap an asset without an approved initial valuation');
    }
    if (valuation.priceE18 !== this.expectedPrice) {
      throw new Error('Oracle heartbeat refuses to change the approved RWRN01 price');
    }
    if (valuation.settlementToken.toLowerCase() !== this.settlementToken.toLowerCase()) {
      throw new Error('Oracle heartbeat settlement token differs from the approved valuation');
    }
    if (valuation.evidenceHash.toLowerCase() !== this.expectedEvidenceHash.toLowerCase()) {
      throw new Error('Oracle heartbeat refuses to change the approved valuation evidence');
    }
  }

  async runOnce() {
    const [chainId, block, valuation, liveSignerSet, broadcasterBalance] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.getBlock(),
      this.publicClient.readContract({
        address: this.oracle,
        abi: signedValuationOracleAbi,
        functionName: 'latest',
        args: [this.asset],
      }),
      this.publicClient.readContract({
        address: this.oracle,
        abi: signedValuationOracleAbi,
        functionName: 'signerSet',
      }),
      this.publicClient.getBalance({ address: this.broadcaster.address }),
    ]);
    if (chainId !== MONAD_TESTNET.id) throw new Error(`Oracle heartbeat RPC returned chain ${chainId}`);
    if (broadcasterBalance === 0n) throw new Error('Oracle heartbeat broadcaster has no MON');
    this.assertHeartbeatBaseline(valuation);

    const allowedSigners = new Set(liveSignerSet.map((signer) => signer.toLowerCase()));
    for (const signer of this.signerAccounts) {
      if (!allowedSigners.has(signer.address.toLowerCase())) {
        throw new Error(`Oracle heartbeat signer ${signer.address} is not in the live signer set`);
      }
    }

    const intervalSeconds = BigInt(Math.ceil(this.config.V2_ORACLE_HEARTBEAT_INTERVAL_MS / 1_000));
    if (!shouldPublishOracleHeartbeat(valuation.observedAt, block.timestamp, intervalSeconds)) {
      return { published: false, nonce: valuation.nonce, observedAt: valuation.observedAt } as const;
    }
    if (block.timestamp <= valuation.observedAt) {
      throw new Error('Oracle heartbeat requires a block newer than the latest valuation');
    }

    const attestation = {
      asset: this.asset,
      settlementToken: this.settlementToken,
      priceE18: this.expectedPrice,
      observedAt: block.timestamp,
      validUntil: block.timestamp + BigInt(this.config.V2_ORACLE_HEARTBEAT_VALIDITY_SECONDS),
      nonce: valuation.nonce + 1n,
      evidenceHash: this.expectedEvidenceHash,
    } as const;
    const typedData = buildOracleHeartbeatTypedData(this.oracle, attestation);
    const digest = hashTypedData(typedData);
    const onChainDigest = await this.publicClient.readContract({
      address: this.oracle,
      abi: signedValuationOracleAbi,
      functionName: 'hashAttestation',
      args: [attestation],
    });
    if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
      throw new Error('Oracle heartbeat local and on-chain digests differ');
    }

    const signatures = await Promise.all(this.signerAccounts.map((signer) => signer.signTypedData(typedData)));
    for (const [index, signature] of signatures.entries()) {
      const recovered = await recoverTypedDataAddress({ ...typedData, signature });
      if (recovered.toLowerCase() !== this.signerAccounts[index]!.address.toLowerCase()) {
        throw new Error(`Oracle heartbeat signature ${index + 1} recovery failed`);
      }
    }

    const simulation = await this.publicClient.simulateContract({
      account: this.broadcaster,
      address: this.oracle,
      abi: signedValuationOracleAbi,
      functionName: 'submit',
      args: [attestation, signatures],
    });
    const transactionHash = await this.walletClient.writeContract(simulation.request);
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: Number(this.config.INDEXER_CONFIRMATIONS),
      timeout: 180_000,
    });
    if (receipt.status !== 'success') throw new Error(`Oracle heartbeat reverted: ${transactionHash}`);

    const accepted = await this.publicClient.readContract({
      address: this.oracle,
      abi: signedValuationOracleAbi,
      functionName: 'latest',
      args: [this.asset],
    });
    if (accepted.digest.toLowerCase() !== digest.toLowerCase() || accepted.nonce !== attestation.nonce) {
      throw new Error('Oracle heartbeat receipt does not match the live valuation');
    }
    console.log(`RWRN01 oracle heartbeat accepted at nonce ${attestation.nonce}: ${transactionHash}`);
    return { published: true, nonce: attestation.nonce, observedAt: attestation.observedAt, transactionHash } as const;
  }

  async run() {
    this.running = true;
    console.log(`RWRN01 oracle heartbeat active every ${this.config.V2_ORACLE_HEARTBEAT_INTERVAL_MS / 60_000} minutes.`);
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
        console.error('RWRN01 oracle heartbeat failed', error);
      }
      if (this.running) {
        const checkInterval = Math.min(60_000, this.config.V2_ORACLE_HEARTBEAT_INTERVAL_MS);
        await this.wait(checkInterval);
      }
    }
  }
}
