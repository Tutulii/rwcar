import { timingSafeEqual } from 'node:crypto';
import { assets, valuationSnapshots, type RwcarDb } from '@rwcar/db';
import {
  AddressSchema,
  HashSchema,
  MONAD_TESTNET,
  protocolModuleFactoryV2Abi,
  signedValuationOracleAbi,
  UintStringSchema,
} from '@rwcar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { CleanverseClient } from '../services/cleanverse.js';
import type { EvidenceService } from '../services/evidence.js';
import type { ChainService, ValuationAttestation } from '../services/chain.js';
import { cleanverseOwnerMessage, verifyCleanverseOwnerSignature } from '../services/cleanverse-activation.js';

const AssetRegistrationSchema = z.object({
  address: AddressSchema,
  name: z.string().min(1).max(128),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(18),
  cleanverseRequestId: z.string().min(1),
  evidenceHash: HashSchema.nullable().default(null),
  valuationHash: HashSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});

const ValuationSchema = z.object({
  asset: AddressSchema,
  valueMinor: z.string().regex(/^\d+$/),
  currency: z.string().min(3).max(12),
  source: z.string().min(1).max(128),
  evidenceHash: HashSchema,
  validUntil: z.number().int().positive(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});

const V2ValuationAttestationSchema = z.object({
  asset: AddressSchema,
  settlementToken: AddressSchema,
  priceE18: UintStringSchema,
  observedAt: UintStringSchema,
  validUntil: UintStringSchema,
  nonce: UintStringSchema,
  evidenceHash: HashSchema,
});

const V2ValuationSubmissionSchema = V2ValuationAttestationSchema.extend({
  signatures: z.array(z.string().regex(/^0x[a-fA-F0-9]{130}$/)).min(2).max(3),
});

const OwnerSignatureSchema = z.string().regex(/^0x[a-fA-F0-9]{130}$/);

const ValidatorRegistrarPrepareSchema = z.object({
  factory: AddressSchema,
});

const ValidatorRegistrarGrantSchema = ValidatorRegistrarPrepareSchema.extend({
  ownerSignature: OwnerSignatureSchema,
});

const ValidatorRuleSchema = z.object({
  allowed_group: z.string().max(2).default(''),
  allowed_sub_group: z.string().max(2).default(''),
  min_tier: z.number().int().min(0).max(99).default(0),
  min_sub_tier: z.number().int().min(0).max(99).default(0),
  is_black_list: z.boolean().optional(),
  countries: z.array(z.string().regex(/^[A-Za-z]{2}$/).transform((country) => country.toUpperCase())).max(249).optional(),
});

const ValidatorPoolRegistrationSchema = z.object({
  pool: AddressSchema,
  rule: ValidatorRuleSchema,
  ownerSignature: OwnerSignatureSchema,
});

const ValidatorPoolPrepareSchema = z.object({
  pool: AddressSchema,
});

const CustodyRegistrationCalldataSchema = z.object({
  factory: AddressSchema,
  pool: AddressSchema,
  aToken: AddressSchema,
  custodyAddress: AddressSchema,
});

function requireInternalKey(request: FastifyRequest, config: ApiConfig) {
  if (!config.ADMIN_API_KEY) throw new AppError(404, 'NOT_FOUND', 'Route not found');
  const supplied = request.headers['x-admin-key'];
  const candidate = typeof supplied === 'string' ? supplied : '';
  const expected = Buffer.from(config.ADMIN_API_KEY);
  const actual = Buffer.from(candidate);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(403, 'FORBIDDEN', 'Invalid internal API credential');
  }
}

export function registerInternalRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  db: RwcarDb,
  cleanverse: CleanverseClient,
  chain: ChainService,
  evidence?: EvidenceService,
) {
  app.post('/internal/v1/assets', { schema: { body: AssetRegistrationSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof AssetRegistrationSchema>;
    const application = await cleanverse.queryAssetApplication(input.cleanverseRequestId);
    if (!application.issued) {
      throw new AppError(422, 'CVA_NOT_ISSUED', `Cleanverse application is ${application.status ?? 'unknown'}, not ISSUED`);
    }
    const normalized = input.address.toLowerCase();
    if (application.chain !== MONAD_TESTNET.cleanverseChain) {
      throw new AppError(422, 'CVA_CHAIN_MISMATCH', 'Cleanverse request is not issued on Monad');
    }
    if (application.tokenAddress !== normalized) {
      throw new AppError(422, 'CVA_ADDRESS_MISMATCH', 'Cleanverse request does not bind the submitted A-Token address');
    }
    if (!application.pauseKnown) {
      throw new AppError(422, 'CVA_PAUSE_UNKNOWN', 'Cleanverse did not return authoritative pause status');
    }
    if (application.paused) throw new AppError(422, 'CVA_PAUSED', 'Cleanverse A-Token is paused');
    const [record] = await db.insert(assets).values({
      chainId: MONAD_TESTNET.id,
      address: normalized,
      name: input.name,
      symbol: input.symbol,
      decimals: input.decimals,
      cleanverseRequestId: input.cleanverseRequestId,
      cleanverseStatus: 'ISSUED',
      paused: application.paused,
      enabled: input.enabled,
      evidenceHash: input.evidenceHash,
      valuationHash: input.valuationHash,
      metadata: { cleanverse: application.raw },
    }).onConflictDoUpdate({
      target: [assets.chainId, assets.address],
      set: {
        name: input.name,
        symbol: input.symbol,
        decimals: input.decimals,
        cleanverseRequestId: input.cleanverseRequestId,
        cleanverseStatus: 'ISSUED',
        paused: application.paused,
        enabled: input.enabled,
        evidenceHash: input.evidenceHash,
        valuationHash: input.valuationHash,
        metadata: { cleanverse: application.raw },
        updatedAt: new Date(),
      },
    }).returning();
    return record;
  });

  app.post('/internal/v1/valuations', { schema: { body: ValuationSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof ValuationSchema>;
    const assetAddress = input.asset as Address;
    const evidenceHash = input.evidenceHash as Hex;
    const signature = input.signature as Hex;
    if (input.validUntil <= Math.floor(Date.now() / 1000)) throw new AppError(422, 'VALUATION_EXPIRED', 'Valuation is already expired');
    const [asset] = await db.select().from(assets).where(and(
      eq(assets.chainId, MONAD_TESTNET.id),
      eq(assets.address, input.asset.toLowerCase()),
    )).limit(1);
    if (!asset?.enabled || asset.cleanverseStatus !== 'ISSUED') throw new AppError(422, 'ASSET_NOT_ALLOWED', 'Asset is not an enabled issued CVA');
    const message = {
      asset: assetAddress,
      valueMinor: BigInt(input.valueMinor),
      currency: input.currency,
      evidenceHash,
      validUntil: BigInt(input.validUntil),
      source: input.source,
    } as const;
    const domain = { name: 'RWCAR Valuation', version: '1', chainId: MONAD_TESTNET.id, verifyingContract: assetAddress } as const;
    const types = { Valuation: [
      { name: 'asset', type: 'address' },
      { name: 'valueMinor', type: 'uint256' },
      { name: 'currency', type: 'string' },
      { name: 'evidenceHash', type: 'bytes32' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'source', type: 'string' },
    ] } as const;
    const signer = await recoverTypedDataAddress({ domain, types, primaryType: 'Valuation', message, signature });
    const allowed = new Set(config.VALUATION_SIGNERS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    if (!allowed.has(signer.toLowerCase())) throw new AppError(403, 'UNAUTHORIZED_VALUER', 'Valuation signer is not authorized');
    const valuationHash = keccak256(encodeAbiParameters(
      parseAbiParameters('address,uint256,string,bytes32,uint64,string,address'),
      [assetAddress, BigInt(input.valueMinor), input.currency, evidenceHash, BigInt(input.validUntil), input.source, signer],
    ));
    const [record] = await db.insert(valuationSnapshots).values({
      assetAddress: input.asset.toLowerCase(),
      valueMinor: input.valueMinor,
      currency: input.currency,
      source: input.source,
      evidenceHash: input.evidenceHash,
      signer: signer.toLowerCase(),
      signature,
      validUntil: new Date(input.validUntil * 1000),
    }).returning();
    await db.update(assets).set({ valuationHash, updatedAt: new Date() }).where(eq(assets.id, asset.id));
    return { ...record, valuationHash };
  });

  app.post('/internal/v2/valuations/prepare', { schema: { body: V2ValuationAttestationSchema } }, async (request) => {
    requireInternalKey(request, config);
    const prepared = await prepareV2Valuation(
      request.body as z.infer<typeof V2ValuationAttestationSchema>,
      config,
      db,
      chain,
    );
    return prepared;
  });

  app.post('/internal/v2/valuations/calldata', { schema: { body: V2ValuationSubmissionSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof V2ValuationSubmissionSchema>;
    const prepared = await prepareV2Valuation(input, config, db, chain);
    const recoveredSigners = await Promise.all(input.signatures.map((signature) => recoverTypedDataAddress({
      ...prepared.typedData,
      signature: signature as Hex,
    })));
    const uniqueSigners = new Set(recoveredSigners.map((signer) => signer.toLowerCase()));
    if (uniqueSigners.size !== recoveredSigners.length) {
      throw new AppError(422, 'DUPLICATE_VALUATION_SIGNER', 'Valuation signatures must come from unique signers');
    }
    const allowed = new Set(prepared.signerSet.map((signer) => signer.toLowerCase()));
    if (recoveredSigners.some((signer) => !allowed.has(signer.toLowerCase()))) {
      throw new AppError(403, 'UNAUTHORIZED_VALUER', 'A valuation signature is not from the live oracle signer set');
    }
    if (recoveredSigners.length < prepared.threshold) {
      throw new AppError(422, 'VALUATION_THRESHOLD_NOT_MET', 'At least two distinct live oracle signers are required');
    }
    const signatures = input.signatures as Hex[];
    return {
      ...prepared,
      recoveredSigners,
      transaction: {
        to: prepared.oracle,
        data: encodeFunctionData({
          abi: signedValuationOracleAbi,
          functionName: 'submit',
          args: [prepared.attestation, signatures],
        }),
        value: '0',
        description: `Submit 2-of-3 signed valuation nonce ${prepared.attestation.nonce}`,
      },
    };
  });

  app.post('/internal/v2/cleanverse/registrar/prepare', { schema: { body: ValidatorRegistrarPrepareSchema } }, async (request) => {
    requireInternalKey(request, config);
    const { factory } = request.body as z.infer<typeof ValidatorRegistrarPrepareSchema>;
    const live = await requireLiveFactory(factory as Address, config, chain);
    return {
      chain: MONAD_TESTNET.cleanverseChain,
      factory,
      validator: live.validator,
      owner: live.owner,
      message: cleanverseOwnerMessage(MONAD_TESTNET.cleanverseChain, factory as Address),
      signatureMethod: 'personal_sign',
      warning: 'Sign only this exact plaintext message. Never submit or store the owner private key.',
    };
  });

  app.post('/internal/v2/cleanverse/registrar/grant', { schema: { body: ValidatorRegistrarGrantSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof ValidatorRegistrarGrantSchema>;
    const factory = input.factory as Address;
    const live = await requireLiveFactory(factory, config, chain);
    const recoveredOwner = await verifyCleanverseOwnerSignature(
      MONAD_TESTNET.cleanverseChain,
      factory,
      live.owner,
      input.ownerSignature as Hex,
    );
    const mutation = await cleanverse.grantValidatorRegistrar(
      MONAD_TESTNET.cleanverseChain,
      factory,
      input.ownerSignature,
    );
    return { ...mutation, owner: recoveredOwner, confirmationRequired: true };
  });

  app.post('/internal/v2/cleanverse/pools/register', { schema: { body: ValidatorPoolRegistrationSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof ValidatorPoolRegistrationSchema>;
    const pool = input.pool as Address;
    requireConfiguredPool(pool, config);
    const owner = await chain.contractOwner(pool);
    const recoveredOwner = await verifyCleanverseOwnerSignature(
      MONAD_TESTNET.cleanverseChain,
      pool,
      owner,
      input.ownerSignature as Hex,
    );
    const mutation = await cleanverse.registerValidatorPool(
      MONAD_TESTNET.cleanverseChain,
      pool,
      input.rule,
      input.ownerSignature,
    );
    return { ...mutation, owner: recoveredOwner, confirmationRequired: true };
  });

  app.post('/internal/v2/cleanverse/pools/prepare', { schema: { body: ValidatorPoolPrepareSchema } }, async (request) => {
    requireInternalKey(request, config);
    const { pool: poolInput } = request.body as z.infer<typeof ValidatorPoolPrepareSchema>;
    const pool = poolInput as Address;
    requireConfiguredPool(pool, config);
    const owner = await chain.contractOwner(pool);
    return {
      chain: MONAD_TESTNET.cleanverseChain,
      pool,
      owner,
      message: cleanverseOwnerMessage(MONAD_TESTNET.cleanverseChain, pool),
      signatureMethod: 'personal_sign',
      warning: 'Sign only this exact plaintext message. Never submit or store the owner private key.',
    };
  });

  app.post('/internal/v2/cleanverse/custody/calldata', { schema: { body: CustodyRegistrationCalldataSchema } }, async (request) => {
    requireInternalKey(request, config);
    const input = request.body as z.infer<typeof CustodyRegistrationCalldataSchema>;
    const factory = input.factory as Address;
    const pool = input.pool as Address;
    const aToken = input.aToken as Address;
    const custodyAddress = input.custodyAddress as Address;
    const live = await requireLiveFactory(factory, config, chain);
    requireConfiguredPool(pool, config);
    const module = await chain.factoryModule(factory, custodyAddress);
    if (module.controller.toLowerCase() !== pool.toLowerCase()) {
      throw new AppError(422, 'CUSTODY_CONTROLLER_MISMATCH', 'Custody module is not controlled by the submitted pool');
    }
    if (module.token.toLowerCase() !== aToken.toLowerCase()) {
      throw new AppError(422, 'CUSTODY_TOKEN_MISMATCH', 'Custody module token is not the submitted A-Token');
    }
    if (module.moduleType !== 1 && module.moduleType !== 3) {
      throw new AppError(422, 'MODULE_NOT_CUSTODY', 'Only a factory-deployed collateral vault or settlement escrow can receive contract CVI');
    }
    const data = encodeFunctionData({
      abi: protocolModuleFactoryV2Abi,
      functionName: 'registerCvaCustody',
      args: [pool, aToken, custodyAddress],
    });
    await chain.simulateTransaction(live.owner, factory, data);
    return {
      verifiedBinding: {
        controller: module.controller,
        token: module.token,
        moduleType: module.moduleType === 1 ? 'COLLATERAL_VAULT' : 'SETTLEMENT_ESCROW',
      },
      transaction: {
        from: live.owner,
        to: factory,
        data,
        value: '0',
        description: `Register contract CVI for custody module ${custodyAddress}`,
      },
    };
  });

  app.post('/internal/v1/documents/:asset', async (request) => {
    requireInternalKey(request, config);
    if (!evidence) throw new AppError(503, 'EVIDENCE_STORAGE_UNAVAILABLE', 'Evidence storage is not configured');
    const parsed = z.object({ asset: AddressSchema }).parse(request.params);
    const [asset] = await db.select().from(assets).where(and(
      eq(assets.chainId, MONAD_TESTNET.id),
      eq(assets.address, parsed.asset.toLowerCase()),
      eq(assets.enabled, true),
    )).limit(1);
    if (!asset) throw new AppError(404, 'ASSET_NOT_FOUND', 'Enabled issued asset was not found');
    const file = await request.file({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    if (!file) throw new AppError(400, 'DOCUMENT_REQUIRED', 'Attach one evidence file');
    const uploaderField = file.fields.uploadedBy;
    const uploadedBy = String(uploaderField && !Array.isArray(uploaderField) && 'value' in uploaderField ? uploaderField.value : 'internal');
    if (!/^0x[a-fA-F0-9]{40}$/.test(uploadedBy)) throw new AppError(400, 'INVALID_UPLOADER', 'uploadedBy must be an EVM address');
    return evidence.upload(parsed.asset, uploadedBy, file);
  });
}

async function requireLiveFactory(factory: Address, config: ApiConfig, chain: ChainService) {
  const configured = config.PROTOCOL_MODULE_FACTORY_V2_ADDRESS as Address | undefined;
  if (!configured) throw new AppError(503, 'V2_FACTORY_NOT_DEPLOYED', 'ProtocolModuleFactoryV2 is not configured');
  if (configured.toLowerCase() !== factory.toLowerCase()) {
    throw new AppError(422, 'FACTORY_ADDRESS_MISMATCH', 'Factory does not match the trusted deployment configuration');
  }
  const live = await chain.factoryMetadata(factory);
  if (live.owner === zeroAddress) throw new AppError(422, 'FACTORY_OWNER_INVALID', 'Factory has no live owner');
  if (live.pendingOwner !== zeroAddress) {
    throw new AppError(409, 'FACTORY_OWNERSHIP_PENDING', 'Complete or cancel the factory ownership transfer before Cleanverse activation');
  }
  if (live.validator.toLowerCase() !== config.COMPLIANCE_VALIDATOR_ADDRESS.toLowerCase()) {
    throw new AppError(422, 'VALIDATOR_ADDRESS_MISMATCH', 'Factory is not bound to the configured Cleanverse validator');
  }
  return live;
}

function requireConfiguredPool(pool: Address, config: ApiConfig) {
  const configuredPools = [config.REPO_MARKET_V2_ADDRESS, config.MARGIN_ENGINE_V2_ADDRESS]
    .filter((address): address is string => Boolean(address))
    .map((address) => address.toLowerCase());
  if (!configuredPools.includes(pool.toLowerCase())) {
    throw new AppError(422, 'POOL_ADDRESS_MISMATCH', 'Pool does not match a trusted V2 deployment address');
  }
}

async function prepareV2Valuation(
  input: z.infer<typeof V2ValuationAttestationSchema>,
  config: ApiConfig,
  db: RwcarDb,
  chain: ChainService,
) {
  const oracle = config.VALUATION_ORACLE_V2_ADDRESS as Address | undefined;
  if (!oracle) throw new AppError(503, 'V2_ORACLE_NOT_DEPLOYED', 'SignedValuationOracle is not configured');
  if (input.settlementToken.toLowerCase() !== config.V2_SETTLEMENT_TOKEN_ADDRESS.toLowerCase()) {
    throw new AppError(422, 'SETTLEMENT_TOKEN_MISMATCH', 'Valuation settlement token does not match the V2 market');
  }
  const [asset] = await db.select().from(assets).where(and(
    eq(assets.chainId, MONAD_TESTNET.id),
    eq(assets.address, input.asset.toLowerCase()),
  )).limit(1);
  if (!asset?.enabled || asset.cleanverseStatus !== 'ISSUED' || asset.paused) {
    throw new AppError(422, 'ASSET_NOT_ALLOWED', 'Asset is not an enabled, unpaused, issued CVA');
  }
  const attestation: ValuationAttestation = {
    asset: input.asset as Address,
    settlementToken: input.settlementToken as Address,
    priceE18: BigInt(input.priceE18),
    observedAt: BigInt(input.observedAt),
    validUntil: BigInt(input.validUntil),
    nonce: BigInt(input.nonce),
    evidenceHash: input.evidenceHash as Hex,
  };
  const blockNumber = await chain.blockNumber();
  const chainTimestamp = await chain.blockTimestamp(blockNumber);
  if (attestation.priceE18 === 0n || attestation.evidenceHash === `0x${'0'.repeat(64)}`) {
    throw new AppError(422, 'INVALID_VALUATION', 'Price and evidence hash must be non-zero');
  }
  if (attestation.observedAt > chainTimestamp || attestation.validUntil < chainTimestamp
    || attestation.validUntil <= attestation.observedAt) {
    throw new AppError(422, 'INVALID_VALUATION_WINDOW', 'Valuation timestamps are invalid at the referenced chain block');
  }
  const [nonceState, signerSet, contractDigest] = await Promise.all([
    chain.valuationNonceState(oracle, attestation.asset, attestation.nonce),
    chain.valuationSignerSet(oracle),
    chain.valuationDigest(oracle, attestation),
  ]);
  if (nonceState.unavailable || attestation.nonce <= nonceState.lastNonce) {
    throw new AppError(409, 'VALUATION_NONCE_UNAVAILABLE', 'Valuation nonce has already been consumed or invalidated');
  }
  const typedData = buildV2ValuationTypedData(oracle, attestation);
  const localDigest = hashTypedData(typedData);
  if (localDigest.toLowerCase() !== contractDigest.toLowerCase()) {
    throw new AppError(500, 'VALUATION_DIGEST_MISMATCH', 'Local and oracle EIP-712 digests do not match');
  }
  return {
    oracle,
    threshold: 2,
    signerSet,
    attestation,
    digest: contractDigest,
    typedData,
    asOf: { blockNumber: blockNumber.toString(), chainTimestamp: chainTimestamp.toString() },
  };
}

export function buildV2ValuationTypedData(oracle: Address, attestation: ValuationAttestation) {
  return {
    domain: {
      name: 'RWCAR Signed Valuation Oracle',
      version: '2',
      chainId: MONAD_TESTNET.id,
      verifyingContract: oracle,
    },
    types: { Attestation: [
      { name: 'asset', type: 'address' },
      { name: 'settlementToken', type: 'address' },
      { name: 'priceE18', type: 'uint256' },
      { name: 'observedAt', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'evidenceHash', type: 'bytes32' },
    ] },
    primaryType: 'Attestation' as const,
    message: attestation,
  } as const;
}
