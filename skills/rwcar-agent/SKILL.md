---
name: rwcar-agent
description: Operate the RWCAR institutional RWA repo market through its OAuth-protected MCP tools. Use when an AI agent must discover Cleanverse-verified assets, assess repo offers, manage tri-party vault balances, prepare or execute partial-fill repo transactions, repay positions, claim settlement funds, participate in liquidation auctions, or manage shared-collateral margin accounts on Monad. Enforces prepare-before-execute, immutable intent hashes, idempotency, signed institutional mandates, live CVI/CVA checks, and human approval gates.
---

# RWCAR Agent

Operate RWCAR through the reviewed MCP surface. Treat every amount as an integer in token base units and every successful transaction as provisional until both Monad finality and the RWCAR indexer report completion.

## Required workflow

1. Load `/agent-discovery.json` from the deployment, verify the published skill manifest hash against the institution's signed mandate, and authenticate using the institution-issued OAuth client credentials. Never expose the client secret in chat, logs, tool arguments, or generated files.
2. Call `get_protocol_info`, then `list_verified_assets`, then `check_eligibility` for every asset involved before proposing a transaction.
3. Use read tools to select an existing on-chain resource. Do not invent offer, position, auction, claim, valuation, or margin-account identifiers.
4. Generate one UUID idempotency key for the semantic operation. Keep it unchanged across retries.
5. Call the matching `prepare_*` tool. Preparation creates a durable intent but does not sign or submit a transaction.
6. Inspect the returned intent hash, policy decision, quote expiry, `blockingDetails`, `resolvedByTransactions`, `nextActions`, destinations, selectors, values, and transaction descriptions. An allowance listed in `resolvedByTransactions` is handled by the generated approval step and is not a blocker.
7. If the intent is `APPROVAL_REQUIRED`, stop execution and pass its `approvalHandoff` to the human administrator. The administrator signs through the Agent Console; do not manufacture an approval.
8. If policy permits execution, call `execute_intent` with the exact `intentId` and `intentHash` returned by preparation.
9. Subscribe to the OAuth-protected event stream published in `/agent-discovery.json`, or poll `get_execution_status`, until a terminal state. Report each Monad transaction hash and distinguish confirmed from fully indexed completion.

Read [workflows.md](references/workflows.md) for lifecycle-specific sequences, [tool-contracts.md](references/tool-contracts.md) for the 17-tool surface, and [errors-and-recovery.md](references/errors-and-recovery.md) before recovering a failed or ambiguous operation.

## Non-negotiable safety rules

- Never request or use a private key. RWCAR's isolated executor is the only component authorized to sign agent transactions.
- Never construct arbitrary calldata or send a raw transaction. Use only the semantic MCP tools.
- Never bypass CVI, A-Pass, CVA, policy-pool, oracle, vault, balance, allowance, mandate, or human-approval failures.
- Never retry a submitted or ambiguous operation with a new idempotency key. Query the original intent first.
- Never change an intent after preparation. Changed economics require a new preparation and a new UUID.
- Never claim execution from a transaction receipt alone. Require the intent state `COMPLETED` unless explicitly reporting an intermediate state.
- Never infer that an asset is verified from its symbol. Use `list_verified_assets` and live `check_eligibility` results.
- Never invent or post a valuation. RWCAR resolves the latest authorized signed oracle valuation server-side and reports its freshness through protocol and portfolio reads.
- Treat `FAILED_WITH_ALLOWANCE` as a partial-execution incident: an approval may have landed even though the protocol call did not. Inspect status and balance before preparing again.
- Respect all signed-mandate limits even when a human asks for a larger trade; require the institution to replace the mandate through the Agent Console.

## Environment boundary

Determine the chain, contract addresses, and environment from `get_protocol_info`; do not hard-code them from this skill. Cleanverse UAT identities and assets are test credentials, not production KYC or investment-grade attestations. State that boundary in any demo or report based on UAT data.
