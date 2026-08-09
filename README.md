# RWCAR

Railway packaging and the exact deployment order are documented in [docs/RAILWAY_DEPLOYMENT.md](docs/RAILWAY_DEPLOYMENT.md). Generate protected service variables with `npm run prepare:railway`; generated files remain ignored under `.secrets/`.

Institutional RWA repo infrastructure using issued Cleanverse CVAs, verified CVI participants, Monad Testnet atomic settlement, Privy authentication, a Fastify API, PostgreSQL projections, and a reorg-aware indexer.

Start with [Architecture](docs/ARCHITECTURE.md), [V2 protocol specification](docs/V2_PROTOCOL_SPEC.md), [API](docs/API.md), [Agent platform](docs/AGENT_PLATFORM.md), [Threat model](docs/THREAT_MODEL.md), [dependency audit](docs/DEPENDENCY_AUDIT.md), and [Runbook](docs/RUNBOOK.md). Cleanverse-specific persistent notes are in [CVA context](docs/CLEANVERSE_CVA_CONTEXT.md).

V1 remains the immutable Direct-DvP close path. V2 is a separate deployment with tri-party CVA custody, cumulative partial fills, per-fill ACT/365 payoff and early repurchase, signed valuations, Dutch-auction closeout, compliance-aware settlement claims, and an opt-in single-CVA cross-margin engine. A deployed address is not an activated product: V2 readiness stays fail-closed until multisig ownership, delayed risk, 2-of-3 oracle, exact Cleanverse contract-custody registrations, real smoke proofs, reconciliation, and finalized indexing all pass the [activation runbook](docs/RUNBOOK.md).

```sh
npm install
npm run typecheck
npm test
npm run build
```

The optional institutional agent plane adds an OAuth-protected 17-tool MCP server, signed mandates, a dedicated Privy policy-bound wallet, a durable intent/outbox, an isolated signer executor, and an Agent Console. Generate its local protected key material with `npm run prepare:agent-secrets`; see [the agent platform runbook](docs/AGENT_PLATFORM.md) before enabling it.

Generate a non-executing Monad Testnet V2 deployment plan with:

```sh
npm run deploy:uat:v2
```

The command defaults to `V2_DEPLOY_MODE=plan`, requires no private key, makes no network call, and prints constructor inputs plus artifact hashes. Transaction execution has separate chain-specific confirmation and fresh-key interlocks documented in the runbook. The manifest shape is [monad-testnet-v2.template.json](deployments/monad-testnet-v2.template.json).

No synthetic offers, positions, CVI results, or CVA results are used in the running application. Unit tests use local contracts only; UAT acceptance must use real Cleanverse and Monad services.
