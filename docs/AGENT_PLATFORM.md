# RWCAR institutional agent platform

RWCAR exposes a bounded machine interface for institution-owned AI agents. An agent can discover markets, read confirmed portfolio state, prepare semantic actions, and queue an immutable intent. It cannot submit arbitrary calldata, receive a wallet private key, waive Cleanverse checks, or approve its own high-risk action.

The machine surface is V2-only and runs on Monad Testnet. Cleanverse UAT A-Passes and A-Tokens are real UAT records, but synthetic UAT identity enrollment is not production KYC.

## Trust and execution boundaries

```text
Institution administrator
  └─ Agent Console + Privy user wallet
       ├─ creates a dedicated non-exported agent wallet
       ├─ attaches the reviewed Privy signer policy
       ├─ signs the EIP-712 mandate
       └─ signs exceptional intent approvals

AI agent runtime
  └─ OAuth client credentials → short-lived audience-bound JWT
       └─ 17 semantic MCP tools / equivalent REST API
            └─ API: mandate + policy + Cleanverse + on-chain preflight
                 └─ durable PostgreSQL intent and exact transaction steps
                      └─ isolated executor over Railway private networking
                           └─ live Privy policy check → Monad submission
                                └─ receipt finality → finalized indexer projection
```

The API holds Cleanverse, database, and JWT-signing credentials but no Privy authorization private key. The executor holds the Privy authorization key and an internal API key but no database, Cleanverse, administrator, keeper, deployer, or oracle key. Privy enforces the signer policy independently; the contracts repeat all authoritative protocol and compliance checks.

## Public discovery

An agent starts with `GET /agent-discovery.json`. The response publishes:

- the canonical MCP resource URI;
- OAuth authorization-server and protected-resource metadata;
- the token, MCP, and OpenAPI endpoints;
- the durable event feed and resumable SSE endpoint;
- the reviewed skill manifest and download URLs;
- the exact 17-tool name list and safety capabilities.

The downloadable package is rooted at `/agent-skill/SKILL.md`, with its manifest at `/agent-skill/manifest.json`. An institution signs the manifest hash into every mandate. The API accepts only hashes listed in `AGENT_ALLOWED_MANIFEST_HASHES`.

OAuth uses `client_credentials`. Every token request must contain the exact `resource` URI from discovery. Access tokens are ES256 JWTs with a five-minute default lifetime, an MCP-resource audience, institution/agent/wallet binding, credential ID, least-privilege scopes, and a unique token ID. Every authenticated call rechecks the live credential, agent, signer/policy binding, CVI expiry, and mandate, so pause or revocation takes effect before token expiry.

## Provisioning flow

1. Run `npm run prepare:agent-secrets`. The command creates `.secrets/agent-platform.json` with mode 0600 and prints no secret values.
2. Register the stored P-256 public key as a Privy authorization key and create the policy described in [PRIVY_AGENT_POLICY.md](PRIVY_AGENT_POLICY.md). Put only the returned `signerId` and `policyId` into that protected JSON file. Never send the private key to Privy or place it on the API/web services.
3. Regenerate the reviewed skill manifest with `node scripts/generate-agent-skill-manifest.mjs`, review the diff, and generate Railway variables with `npm run prepare:railway`.
4. Deploy PostgreSQL, API, indexer, executor, and web in the order in [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md).
5. In the Agent Console, the institution administrator creates an agent record and a fresh dedicated Privy wallet. The API verifies that wallet ID/address, Ethereum chain type, attached signer policy, and non-imported/non-exported state before binding it permanently.
6. Register or confirm the wallet's Cleanverse A-Pass. The built-in synthetic enrollment button is deliberately UAT-only and rate-limited.
7. Sign a time-bounded EIP-712 mandate that includes the agent wallet, exact skill hash, allowed actions/assets/counterparties/recipients, rate and duration bands, per-transaction notional, UTC daily notional, and auto-execution threshold.
8. Refresh live compliance for every allowed CVA and its policy pool. Only then can the agent become `ACTIVE` and receive an expiring OAuth credential.
9. Fund the dedicated wallet with Monad gas and only the CVA/aUSDC inventory it needs. The Console reports its live MON gas state.

Client secrets are displayed once. RWCAR stores only a scrypt hash. A credential defaults to 30 days and can never exceed 90 days; access tokens remain short lived.

## Machine workflow

1. Fetch discovery and verify the skill hash expected by the institution.
2. Exchange the client ID/secret at `/oauth/token` with `grant_type=client_credentials`, the exact MCP `resource`, and only required scopes.
3. Connect to the streamable HTTP `/mcp` endpoint with the bearer token.
4. Call `get_protocol_info`, `list_verified_assets`, and `check_eligibility` before selecting an action.
5. Generate one UUID idempotency key and call the matching `prepare_*` tool. A retry must reuse the same key and exact inputs.
6. Review the intent hash, policy decision, live quote, `blockingDetails`, `resolvedByTransactions`, projected state, next actions, destinations, selectors, and transaction steps.
7. Stop at `APPROVAL_REQUIRED`. Pass the returned `approvalHandoff` to the institution administrator; only that administrator can sign the hash-bound approval in the Console.
8. Call `execute_intent` with the exact intent ID/hash. The executor refreshes preflight before every not-yet-submitted step and refuses semantic drift.
9. Resume `/agent/v1/events/stream` by event UUID or poll `get_execution_status` through receipt confirmation and finalized index projection. Only `COMPLETED` is a fully reconciled success.

The exact tool contracts and workflows are in [the packaged skill](../skills/rwcar-agent/SKILL.md).

## Intent lifecycle

| State | Meaning | Caller behavior |
| --- | --- | --- |
| `PREPARED` | Policy permits queueing without another signature | Execute before expiry |
| `APPROVAL_REQUIRED` | Risk/notional requires administrator review | Stop and request approval |
| `APPROVED` | Exact intent hash has a live EIP-712 approval | Execute before expiry |
| `QUEUED` / `SIGNING` | Serialized executor work | Poll; never duplicate |
| `SUBMITTED` | Immutable Monad transaction hash recorded | Reconcile the same hash |
| `CONFIRMED` / `INDEXING` | Receipt succeeded; ledger projection pending | Poll |
| `COMPLETED` | Receipt and finalized projection agree | Report success |
| terminal denial/failure states | No further execution | Inspect error and transaction history |

If an allowance transaction confirms but a later protocol transaction fails, the intent becomes `FAILED_WITH_ALLOWANCE`. This is an incident state, not a clean retry: inspect the live allowance and prepare a new semantic action only with a new UUID.

An `INSUFFICIENT_ALLOWANCE` entry in `resolvedByTransactions` is not a denial: the exact approval is already a reviewed step. A `DENIED` response can never have an empty blocker list. `ACTION_NOT_ALLOWED` means the signed mandate excludes the action; `ROLE_NOT_ALLOWED` means the wallet lacks the required seller/lender/beneficiary role.

Portfolio reads preserve the raw on-chain status and add a derived lifecycle state. An ACTIVE position becomes `OVERDUE` immediately after its repayment deadline while the durable keeper retries `startAuction`; supported lifecycle jobs do not dead-letter on temporary oracle or RPC outages. Valuations are selected from the server-managed signed oracle, never supplied by an agent.

Margin discovery includes public fundable accounts and wallet/repo-vault/margin-vault balances. A `DEPOSIT` with `collateralSource=AUTO` can compose a Repo Vault AVAILABLE withdrawal and MarginEngine deposit under the existing human approval gate; executor re-preflight compares only the unexecuted suffix after each confirmed step.

## Safety invariants

- One active executor lease per agent wallet; PostgreSQL advisory locks serialize authority changes and intent creation.
- Mandate replacement, pause, or revocation atomically cancels all unsubmitted work and releases reserved daily notional.
- A submitted hash is never replaced. Ambiguous Privy/RPC/API outcomes recover through the same Privy idempotency key.
- The executor records `SIGNING` before calling Privy. If authority changes inside that unavoidable external-side-effect window, RWCAR fails closed with `AMBIGUOUS_SIGNING_OUTCOME` and requires operator reconciliation instead of risking a new signature.
- The execution plan allows zero native value only, fixed deployed destinations, exact semantic selectors, and ERC-20 approvals constrained to the preflight transfer graph.
- The executor re-fetches the Privy wallet before signing and refuses address, signer, policy, import, or export drift.
- Read models can delay completion but cannot authorize chain state. Contracts and Cleanverse transfer hooks remain authoritative.
- Agent wallet, signer ID, and policy ID are immutable. Rotate them by pausing/revoking the old agent, reconciling submitted work, and provisioning a new dedicated agent.

## Operations and incidents

- Pause first when behavior is suspicious. This cancels prepared/approved/queued intents; already-submitted hashes continue receipt reconciliation because the chain outcome cannot be undone.
- Revoke a credential for client-secret exposure. Revoke the full agent for signer/policy or wallet compromise; revocation is permanent.
- Rotate the ES256 key by deploying a new key ID/JWK. Existing tokens live at most the configured short TTL.
- Keep the executor at one replica unless wallet-serialization and lease behavior have been load-tested. Database locks still prevent concurrent signing, but one replica is the reviewed deployment.
- Alert on repeated lease expiry, `FAILED_WITH_ALLOWANCE`, policy denial, CVI/CVA changes, receipt timeout, indexer lag, and zero MON balance.
- Preserve correlation IDs, intent hashes, step transaction hashes, mandate signatures, approvals, and finalized index events. Never log access tokens, client secrets, Privy authorization keys, Cleanverse keys, or raw synthetic identity fields.

Mainnet requires independent contract/application audits, production Cleanverse onboarding, institution legal approval, multisig governance, managed secret/KMS controls, database PITR, RPC redundancy, monitoring, and an incident rehearsal. The UAT enable flag must be off.
