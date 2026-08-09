# RWCAR Railway deployment

This runbook deploys the reviewed Monad Testnet V2 release as five Railway services: PostgreSQL, API, indexer/keeper, isolated agent executor, and web. The four application services use the same GitHub repository but different Railway config files.

## 1. Prepare protected variables locally

First generate the isolated agent signing material:

```sh
npm run prepare:agent-secrets
```

Register only the generated P-256 public key with Privy, create the reviewed policy in [PRIVY_AGENT_POLICY.md](PRIVY_AGENT_POLICY.md), then fill its returned `signerId` and `policyId` into `.secrets/agent-platform.json`. Keep the authorization private key local and executor-only.

Then, from the repository root, run:

```sh
npm run prepare:railway
```

This validates the protected UAT inputs and creates four ignored, mode-0600 files without printing their values:

- `.secrets/railway-api.env`
- `.secrets/railway-indexer.env`
- `.secrets/railway-web.env`
- `.secrets/railway-agent-executor.env`

Do not commit, upload, or share these files. Paste each file only into the matching Railway service variable editor. For the Monad UAT demo, the generator places the permissionless gas-funded keeper and two oracle heartbeat signer keys only on the indexer worker. The first oracle signer broadcasts heartbeat transactions on a nonce stream isolated from lifecycle automation. Owner, deployer, seller, buyer, and treasury keys are never exported.

## 2. Create services with exact names

Create one Railway project and use these exact service names so the generated variable references resolve:

1. Add Railway PostgreSQL and name it `Postgres`.
2. Add the GitHub repository as a service named `rwcar-api`.
3. Add the same repository again as `rwcar-indexer`.
4. Add the same repository again as `rwcar-agent-executor`.
5. Add the same repository again as `rwcar-web`.

Keep `rwcar-indexer` at exactly one replica because it owns one keeper transaction nonce stream. Keep `rwcar-agent-executor` at one replica for the reviewed release; PostgreSQL locks still serialize each wallet, but a single executor simplifies incident recovery.

The same worker refreshes the already-approved RWRN01 valuation every ten minutes. It verifies both signers against the live oracle and refuses to change the configured price, settlement token, or canonical evidence hash. This co-located signer arrangement is restricted to Monad UAT; production must use independently operated or HSM-backed signing services.

The API also pins the deployed settlement A-Token runtime hash. If Cleanverse rotates the off-chain deposit-token list, the exact deployed aUSDC may remain usable only when its bytecode still matches that reviewed hash, its live token policy is unpaused, the wallet has an active A-Pass, and the Cleanverse on-chain policy pool returns eligible. A registry miss alone never bypasses those on-chain checks.

## 3. Select each config file

In each application service settings, set the config-as-code file path:

| Service | Railway config path |
| --- | --- |
| `rwcar-api` | `/deploy/railway/api.railway.json` |
| `rwcar-indexer` | `/deploy/railway/indexer.railway.json` |
| `rwcar-agent-executor` | `/deploy/railway/agent-executor.railway.json` |
| `rwcar-web` | `/deploy/railway/web.railway.json` |

The API pre-deploy command runs all migrations and inserts the exact Cleanverse-issued RWRN01 release record only when absent. It never overrides a later operator pause or disable action.

## 4. Add variables and public domains

1. Generate a public domain for `rwcar-api` and `rwcar-web`. Do not generate one for `rwcar-agent-executor`.
2. Paste `.secrets/railway-api.env` into `rwcar-api` variables.
3. Paste `.secrets/railway-indexer.env` into `rwcar-indexer` variables.
4. Paste `.secrets/railway-agent-executor.env` into `rwcar-agent-executor` variables.
5. Paste `.secrets/railway-web.env` into `rwcar-web` variables.
6. Add the final `rwcar-web` origin to the Privy app's permitted web origins if that protection is enabled.

The generated files use Railway references for `Postgres.DATABASE_URL`, the API public/private domains, and the web public domain. The executor reaches the API over `http://${{rwcar-api.RAILWAY_PRIVATE_DOMAIN}}:${{rwcar-api.PORT}}`; the API file explicitly fixes `PORT=3001` so that private reference is deterministic. The browser variables are intentionally build-time values; changing them requires a web redeploy.

## 5. Deploy in order

1. Deploy `Postgres`.
2. Deploy `rwcar-api`; confirm migrations/bootstrap and `/health` succeed.
3. Deploy `rwcar-indexer`; wait until every V2 source catches up to the finalized head.
4. Deploy `rwcar-agent-executor`; confirm its private health check succeeds and its logs show no raw authorization material.
5. Deploy `rwcar-web`.

## 6. Verify the release

Replace the example domains and run:

```sh
curl -fsS https://YOUR-API-DOMAIN/health
curl -fsS https://YOUR-API-DOMAIN/v2/config
curl -fsS https://YOUR-API-DOMAIN/agent-discovery.json
curl -fsS https://YOUR-API-DOMAIN/.well-known/oauth-protected-resource/mcp
curl -fsS https://YOUR-WEB-DOMAIN/health
```

Then verify in the hosted UI:

- the trusted V2 manifest is accepted;
- RWRN01 is shown as the enabled Cleanverse-issued CVA;
- all five V2 feature gates are enabled;
- seller and buyer CVI badges load;
- the Agent Console can create a dedicated wallet, bind its reviewed signer/policy, sign a mandate, and issue an expiring credential;
- an OAuth token request succeeds only with the exact `/mcp` resource and MCP discovery returns exactly 17 semantic tools;
- a real wallet-signed deposit, offer, partial fill, and early repurchase complete;
- the indexer projects each transaction after finality.

The last wallet-signed trade is release evidence, not a server deployment prerequisite. Never place seller or buyer private keys in Railway.

## Operational checks

- Rotate any credential that has been exposed outside the protected local files before a production launch.
- Keep API, database, and indexer on Railway private networking; expose only API and web domains.
- Keep the Privy authorization key and executor API key on `rwcar-agent-executor` only. The API receives only the matching signer/policy IDs and its own copy of the internal executor authentication key.
- Keep the generated admin key private and use internal routes only for controlled operations.
- Confirm the indexer log shows a successful RWRN01 oracle heartbeat within the previous ten minutes. The active risk configuration enforces a one-hour maximum oracle age.
- Confirm the R2 bucket receives encrypted evidence before relying on document upload in a demo.
