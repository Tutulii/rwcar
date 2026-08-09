import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { toFunctionSelector } from 'viem';
import { marginEngineV2Abi, repoMarketV2Abi, settlementEscrowV2Abi } from '../packages/shared/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

describe('agent skill release artifact', () => {
  it('matches the content-addressed manifest committed to the web and API release', () => {
    const manifest = json('skills/rwcar-agent/manifest.json');
    const digest = createHash('sha256');
    for (const relative of manifest.hashScope) {
      digest.update(`${relative}\0`, 'utf8');
      digest.update(read(`skills/rwcar-agent/${relative}`));
      digest.update('\0', 'utf8');
    }
    const expected = `0x${digest.digest('hex')}`;
    assert.equal(manifest.sha256, expected);
    assert.match(read('src/config/rwcar-agent-manifest.js'), new RegExp(expected));
    assert.match(read('.env.example'), new RegExp(expected));
  });

  it('contains no secret material or arbitrary transaction workflow', () => {
    const material = json('skills/rwcar-agent/manifest.json').hashScope
      .map((relative) => read(`skills/rwcar-agent/${relative}`))
      .join('\n');
    assert.doesNotMatch(material, /privy_app_secret|authorization_private_keys|private key\s*[:=]/i);
    assert.match(material, /Never construct arbitrary calldata/);
    assert.match(material, /prepare-before-execute/);
  });
});

describe('agent service isolation', () => {
  it('copies the public skill only into the API and keeps signer secrets executor-only', () => {
    const api = read('Dockerfile.api');
    const executor = read('Dockerfile.agent-executor');
    assert.match(api, /COPY skills\/rwcar-agent skills\/rwcar-agent/);
    assert.doesNotMatch(api, /PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS/);
    assert.doesNotMatch(executor, /COPY apps\/api apps\/api/);
    assert.match(executor, /USER node/);
  });

  it('converts database decimal transaction values to Privy RPC hex quantities', () => {
    const executor = read('apps/agent-executor/src/executor.ts');
    const rpc = read('apps/agent-executor/src/rpc.ts');
    assert.match(executor, /value: decimalToRpcQuantity\(step\.nativeValue\)/);
    assert.doesNotMatch(executor, /value: step\.nativeValue/);
    assert.match(rpc, /`0x\$\{BigInt\(value\)\.toString\(16\)\}`/);
  });

  it('keeps the reviewed Privy selector policy synchronized with every executable ABI action', () => {
    const policy = read('docs/PRIVY_AGENT_POLICY.md');
    const executable = {
      RepoMarketV2: [
        'depositCollateral', 'withdrawCollateral', 'createOffer', 'fillOffer', 'cancelOffer',
        'finalizeOfferExpiry', 'repurchase', 'startAuction', 'buyAuction',
        'finalizeFailedAuction', 'claimDefaultCollateral', 'claimCollateralOnOracleFailure',
      ],
      SettlementEscrowV2: ['claim'],
      MarginEngineV2: [
        'depositCollateral', 'withdrawAvailable', 'openMarginAccount', 'addMarginCollateral',
        'withdrawExcessCollateral', 'fundMarginAccount', 'closeFunding', 'repayExposure',
        'declarePaymentDefault', 'openMarginCall', 'cureMarginCall', 'startMarginLiquidation',
        'buyMarginAuction', 'finalizeFailedMarginAuction', 'startInKindOracleFallback',
        'materializeLiquidationClaim', 'claimFailedCollateral', 'closeMarginAccount',
      ],
    };
    const abis = { RepoMarketV2: repoMarketV2Abi, SettlementEscrowV2: settlementEscrowV2Abi, MarginEngineV2: marginEngineV2Abi };
    for (const [contract, functions] of Object.entries(executable)) {
      for (const functionName of functions) {
        const item = abis[contract].find((entry) => entry.type === 'function' && entry.name === functionName);
        assert.ok(item, `${contract}.${functionName} is missing from the ABI`);
        const selector = toFunctionSelector(item);
        assert.ok(policy.includes(`| \`${functionName}\` | \`${selector}\` |`), `${contract}.${functionName} policy selector drifted`);
      }
    }
  });

  it('generates four service-specific Railway variable files with a private executor link', () => {
    const generator = read('scripts/generate-railway-env.mjs');
    for (const name of ['railway-api.env', 'railway-indexer.env', 'railway-web.env', 'railway-agent-executor.env']) {
      assert.match(generator, new RegExp(name.replace('.', '\\.')));
    }
    assert.match(generator, /rwcar-api\.RAILWAY_PRIVATE_DOMAIN/);
    assert.match(generator, /PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS/);
    assert.match(generator, /AGENT_AUDIENCE/);
    assert.match(generator, /AGENT_ALLOWED_MANIFEST_HASHES/);
  });

  it('keeps every generated credential file outside Git and Docker contexts', () => {
    assert.match(read('.gitignore'), /^\.secrets\/$/m);
    assert.match(read('.dockerignore'), /^\.secrets$/m);
  });

  it('pins institutional signatures to the canonical administrator after agent wallet creation', () => {
    const app = read('src/AppLive.jsx');
    const console = read('src/AgentConsole.jsx');
    assert.match(app, /const primaryWallet = wallets\.find/);
    assert.match(app, /const wallet = primaryWallet \|\| externalWallet \|\| wallets\[0\]/);
    assert.match(console, /institution\?\.adminWallet \|\| adminAddress/);
    assert.match(console, /requireInstitutionAdminWallet\(\)/);
    assert.doesNotMatch(console, /signTypedData\(challenge(?:\.typedData)?, \{ address: adminAddress \}\)/);
  });

  it('keeps onboarding to three guided steps with an explicit access choice', () => {
    const console = read('src/AgentConsole.jsx');
    assert.match(console, /Step 1 of 3/);
    assert.match(console, /Verify Identity & Sign Mandate/);
    assert.match(console, /Generate Read-only Credential/);
    assert.match(console, /Generate Autonomous Trading Credential/);
    assert.match(console, /executionMode.*AUTONOMOUS/);
    assert.match(console, /No per-intent approval/);
    assert.match(console, /const READ_SCOPES = \['protocol:read'\]/);
    assert.match(console, /const READ_WRITE_SCOPES = SCOPES\.map/);
    assert.match(console, /className="agent-advanced-console"/);
    assert.match(console, /Advanced institutional controls/);
  });

  it('keeps the reviewed Hono advisory path unreachable in the Linux API image', () => {
    assert.match(read('Dockerfile.api'), /^FROM node:22-bookworm-slim/m);
    const apiSources = [read('apps/api/src/routes/mcp.ts'), read('apps/api/src/app.ts')].join('\n');
    assert.doesNotMatch(apiSources, /serveStatic|serve-static/);
    assert.match(read('docs/DEPENDENCY_AUDIT.md'), /GHSA-frvp-7c67-39w9/);
  });
});
