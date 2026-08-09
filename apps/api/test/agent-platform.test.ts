import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AgentClaimSchema,
  AgentMandateConstraintsSchema,
  AllAgentScopes,
} from '@rwcar/shared';
import { loadConfig } from '../src/config.js';
import {
  AgentJwtService,
  canonicalHash,
  canonicalJson,
  hashClientSecret,
  verifyClientSecret,
} from '../src/services/agent-crypto.js';
import { buildAgentDiscovery } from '../src/routes/agent-discovery.js';
import { RWCAR_MCP_TOOLS, RWCAR_MCP_TOOL_SCOPES } from '../src/routes/mcp.js';
import { TokenBodySchema } from '../src/routes/oauth.js';
import {
  deriveRepoPositionLifecycle,
  preflightMatchesRemainingProtocolSteps,
  resolveMandateApproval,
  resolveIntentDiagnostics,
} from '../src/services/agent.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateJwk = privateKey.export({ format: 'jwk' });
const manifestHash = `0x${'12'.repeat(32)}`;
const required = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/rwcar',
  CLEANVERSE_API_ID: 'test-id',
  CLEANVERSE_API_KEY: Buffer.alloc(32, 1).toString('base64'),
  PRIVY_APP_ID: 'test-app',
  PRIVY_APP_SECRET: 'test-secret',
};
const enabled = {
  ...required,
  AGENT_PLATFORM_ENABLED: 'true',
  AGENT_ISSUER_URL: 'https://api.example.test',
  AGENT_AUDIENCE: 'https://api.example.test/mcp',
  AGENT_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  AGENT_JWT_KEY_ID: 'test-es256-key',
  AGENT_EXECUTOR_API_KEY: 'x'.repeat(48),
  PRIVY_AGENT_SIGNER_ID: 'signer-test',
  PRIVY_AGENT_POLICY_ID: 'policy-test',
  AGENT_ALLOWED_MANIFEST_HASHES: manifestHash,
};

describe('agent cryptographic boundary', () => {
  it('canonicalizes object keys deterministically while preserving array order', () => {
    assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
    assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
    assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  });

  it('stores a memory-hard client-secret hash and rejects the wrong secret', async () => {
    const encoded = await hashClientSecret('correct horse battery staple');
    assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyClientSecret('correct horse battery staple', encoded), true);
    assert.equal(await verifyClientSecret('wrong secret', encoded), false);
  });

  it('publishes only the public ES256 key and verifies audience-bound claims', async () => {
    const config = loadConfig(enabled);
    const jwt = new AgentJwtService(config);
    const token = await jwt.sign({
      agentId: '7caaca70-57ac-4a50-9e35-f74426c806f1',
      institutionId: 'f5bfd4e4-d2d0-47c3-ab8c-66195774fdfd',
      wallet: '0x00000000000000000000000000000000000000aa',
      scopes: ['protocol:read'],
      credentialId: 'ab1c91e1-4a5b-4b69-adde-b25b8d88fdd7',
    });
    const jwks = await jwt.jwks();
    assert.equal('d' in jwks.keys[0]!, false, 'JWKS must never expose the EC private scalar');
    assert.equal(jwks.keys[0]?.kid, 'test-es256-key');
    const claims = await jwt.verify(token);
    assert.equal(claims.wallet, '0x00000000000000000000000000000000000000aa');
    assert.deepEqual(claims.scopes, ['protocol:read']);
  });
});

describe('agent configuration and discovery', () => {
  it('fails closed when required signer, executor, JWT, or manifest material is missing', () => {
    assert.throws(() => loadConfig({ ...required, AGENT_PLATFORM_ENABLED: 'true' }), /Required when agent platform is enabled|manifest hash/);
  });

  it('rejects synthetic CVI enrollment against a non-UAT Cleanverse host', () => {
    assert.throws(() => loadConfig({
      ...enabled,
      AGENT_UAT_SYNTHETIC_CVI_ENABLED: 'true',
      CLEANVERSE_BASE_URL: 'https://api.cleanverse.com/api/cooperate',
    }), /permitted only against Cleanverse UAT/);
  });

  it('publishes one canonical MCP resource and exactly 17 semantic tools', () => {
    const config = loadConfig(enabled);
    const discovery = buildAgentDiscovery(config, { sha256: manifestHash, version: '1.0.0' });
    assert.equal(discovery.resource, 'https://api.example.test/mcp');
    assert.equal(discovery.mcp, discovery.resource);
    assert.equal(discovery.oauth.tokenEndpoint, 'https://api.example.test/oauth/token');
    assert.equal(discovery.capabilities.toolCount, 17);
    assert.deepEqual(discovery.capabilities.tools, RWCAR_MCP_TOOLS);
    assert.equal(discovery.capabilities.arbitraryTransactions, false);
    assert.deepEqual(discovery.capabilities.executionModes, ['AUTONOMOUS', 'SUPERVISED']);
    assert.equal(discovery.capabilities.autonomousMandate.perIntentHumanApproval, false);
    assert.equal(discovery.events.stream, 'https://api.example.test/agent/v1/events/stream');
    assert.equal(discovery.events.protocol, 'SSE');
    assert.deepEqual(Object.keys(RWCAR_MCP_TOOL_SCOPES), [...RWCAR_MCP_TOOLS]);
    assert.equal(RWCAR_MCP_TOOL_SCOPES.execute_intent, 'intents:execute');
    assert.equal(RWCAR_MCP_TOOL_SCOPES.get_execution_status, 'protocol:read');
    for (const forbidden of ['raw', 'calldata', 'send_transaction', 'private_key']) {
      assert.equal(RWCAR_MCP_TOOLS.some((tool) => tool.includes(forbidden)), false);
    }
  });

  it('requires an OAuth resource indicator and recognizes every declared scope', () => {
    assert.equal(TokenBodySchema.safeParse({ grant_type: 'client_credentials' }).success, false);
    assert.equal(TokenBodySchema.safeParse({
      grant_type: 'client_credentials',
      client_id: 'client',
      client_secret: 'secret',
      resource: 'https://api.example.test/mcp',
      scope: AllAgentScopes.join(' '),
    }).success, true);
  });
});

describe('signed mandate constraints', () => {
  const now = Math.floor(Date.now() / 1_000);
  const valid = {
    executionMode: 'AUTONOMOUS' as const,
    allowedActions: ['CREATE_OFFER'] as const,
    allowedAssets: ['0x00000000000000000000000000000000000000aa'],
    maxPerTransaction: '1000000',
    maxDailyNotional: '5000000',
    autoExecuteUpTo: '100000',
    minAnnualRateBps: 100,
    maxAnnualRateBps: 1_000,
    minDurationSeconds: 300,
    maxDurationSeconds: 86_400,
    allowedCounterparties: [],
    allowedRecipients: [],
    startsAt: now,
    expiresAt: now + 3_600,
    nonce: '1',
  };

  it('accepts a coherent mandate and rejects inverted or over-broad bounds', () => {
    assert.equal(AgentMandateConstraintsSchema.safeParse(valid).success, true);
    assert.equal(AgentMandateConstraintsSchema.safeParse({ ...valid, autoExecuteUpTo: '1000001' }).success, false);
    assert.equal(AgentMandateConstraintsSchema.safeParse({ ...valid, maxAnnualRateBps: 99 }).success, false);
    assert.equal(AgentMandateConstraintsSchema.safeParse({ ...valid, expiresAt: now }).success, false);
  });

  it('requires no per-intent approval only when autonomy was explicitly signed', () => {
    assert.deepEqual(resolveMandateApproval(valid, 'MARGIN_ACTION', 1_000_000n), {
      decision: 'AUTO_APPROVED',
      reason: null,
    });
    const legacy = AgentMandateConstraintsSchema.parse({ ...valid, executionMode: undefined });
    assert.equal(legacy.executionMode, 'SUPERVISED');
    assert.deepEqual(resolveMandateApproval(legacy, 'MARGIN_ACTION', 1n), {
      decision: 'HUMAN_REQUIRED',
      reason: 'RISK_SENSITIVE_ACTION',
    });
  });

  it('allows claim preparation from a discovered claim ID without agent-invented escrow fields', () => {
    assert.equal(AgentClaimSchema.safeParse({
      idempotencyKey: '74ecf58d-0bbc-4e42-9ec3-f71e2a599cb8',
      claimId: '7',
    }).success, true);
  });
});

describe('agent-drivable lifecycle diagnostics', () => {
  it('never returns an unexplained denial and treats generated approvals as recovery steps', () => {
    assert.deepEqual(resolveIntentDiagnostics('DENIED', null, null, {}).blockingReasons, ['POLICY_DENIED']);
    assert.deepEqual(resolveIntentDiagnostics('REJECTED', null, null, {}).blockingReasons, ['ADMIN_REJECTED']);
    assert.deepEqual(
      resolveIntentDiagnostics('DENIED', 'ACTION_NOT_ALLOWED', null, {}).blockingReasons,
      ['ACTION_NOT_ALLOWED'],
    );
    const allowance = resolveIntentDiagnostics('PREPARED', null, null, {
      blockingReasons: ['INSUFFICIENT_ALLOWANCE'],
      requiredApprovals: [{
        token: '0x0000000000000000000000000000000000000001',
        spender: '0x0000000000000000000000000000000000000002',
        amount: '1',
      }],
    });
    assert.deepEqual(allowance.blockingReasons, []);
    assert.deepEqual(allowance.resolvedByTransactions, ['INSUFFICIENT_ALLOWANCE']);
  });

  it('derives OVERDUE immediately while preserving the authoritative on-chain ACTIVE status', () => {
    const position = {
      status: 'ACTIVE',
      seller: '0x0000000000000000000000000000000000000001',
      buyer: '0x0000000000000000000000000000000000000002',
      repaymentDeadline: new Date(1_000_000),
    };
    const view = deriveRepoPositionLifecycle(
      position,
      '0x0000000000000000000000000000000000000002',
      1_001n,
      true,
    );
    assert.equal(view.onChainStatus, 'ACTIVE');
    assert.equal(view.lifecycleState, 'OVERDUE');
    assert.equal(view.role, 'LENDER');
    assert.equal(view.nextActions.some((action) => action.action === 'START_AUCTION'), true);
  });

  it('re-preflights only the unexecuted suffix of a reviewed composed workflow', () => {
    const first = {
      kind: 'PROTOCOL', status: 'CONFIRMED', destination: '0x0000000000000000000000000000000000000001', calldata: '0x11111111', nativeValue: '0',
    };
    const second = {
      kind: 'PROTOCOL', status: 'PENDING', destination: '0x0000000000000000000000000000000000000002', calldata: '0x22222222', nativeValue: '0',
    };
    assert.equal(preflightMatchesRemainingProtocolSteps([first, second], [{
      to: second.destination,
      data: second.calldata,
      value: second.nativeValue,
      description: 'deposit remaining collateral',
    }]), true);
    assert.equal(preflightMatchesRemainingProtocolSteps([first, second], []), false);
  });
});
