# MCP tool contracts

RWCAR exposes exactly 17 semantic tools. Inputs use decimal strings for `uint256` values, hexadecimal EVM addresses, and UUIDv4 idempotency keys. The server is authoritative; inspect each tool's live JSON schema during MCP discovery.

## Read-only tools

1. `get_protocol_info` — chain, verified deployment, contract map, settlement asset, readiness, safety posture.
2. `check_eligibility` — input: `asset`; performs live CVI/A-Pass, CVA issuance/pause, and policy-pool checks for the bound agent wallet.
3. `list_verified_assets` — enabled Cleanverse-issued CVAs accepted by V2.
4. `list_offers` — finalized open repo offers.
5. `get_offer_quote` — inputs: `offerId`, `principalAmount`; deterministic pro-rata economics without an intent.
6. `get_portfolio` — offers, positions, vault buckets, escrow claims, and recent activity for the agent wallet.
7. `get_margin_accounts` — shared-collateral accounts, exposures, margin calls, and lender relationships.
8. `list_auctions` — input: optional `includeClosed`; current and historical Dutch auctions.
9. `get_execution_status` — input: `intentId`; policy, approval, steps, transaction hashes, indexing, and terminal error.

## Prepare tools

10. `prepare_vault_action` — `DEPOSIT` or `WITHDRAW`; asset, amount, optional recipient, idempotency key.
11. `prepare_create_offer` — CVA, collateral and principal terms, rate, duration, expiry, buyer constraints, valuation inputs, idempotency key as defined by the live schema.
12. `prepare_offer_action` — `FILL`, `CANCEL`, or `FINALIZE_EXPIRY`; offer ID, optional principal amount, idempotency key.
13. `prepare_position_action` — `REPAY`, `START_AUCTION`, `CLAIM_COLLATERAL`, or `CLAIM_ORACLE_FALLBACK`; position ID and action-specific bounds, idempotency key.
14. `prepare_auction_action` — `BUY` or `FINALIZE_FAILED`; auction ID, optional maximum price, idempotency key.
15. `prepare_claim` — indexed settlement-escrow claim and recipient fields defined by the live schema, idempotency key.
16. `prepare_margin_action` — one live-schema margin action, bounded inputs, idempotency key.

Preparation always returns a durable intent. It never authorizes arbitrary calldata and never itself signs a transaction.

## Execution tool

17. `execute_intent` — inputs: `intentId` and exact `expectedIntentHash`. Queues an eligible or human-approved intent. The isolated signer re-runs preflight, verifies destinations/selectors/calldata, and refuses drift before signing.

## Intent states

- `PREPARED`: policy accepted preparation; ready to queue before expiry.
- `APPROVAL_REQUIRED`: administrator signature needed.
- `APPROVED`: approval recorded; ready to queue.
- `QUEUED`, `SIGNING`, `SUBMITTED`, `CONFIRMED`, `INDEXING`: nonterminal execution states. Poll; do not duplicate.
- `COMPLETED`: transaction finalized and indexed.
- `DENIED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `REVERTED`, `FAILED`, `FAILED_WITH_ALLOWANCE`: terminal; inspect details before any new intent.

## Scope mapping

- `protocol:read` — tools 1–9.
- `vault:write` — tool 10.
- `offers:write` — tools 11–12.
- `positions:write` — tool 13.
- `auctions:write` — tool 14.
- `claims:write` — tool 15.
- `margin:write` — tool 16.
- `intents:execute` — tool 17.

OAuth credentials can hold only the scopes granted by the institution. Missing scope is an authorization failure, not a reason to switch credentials or bypass policy.
