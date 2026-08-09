# Errors and recovery

## Compliance and asset errors

- `CVI_INACTIVE`, `CVI_INELIGIBLE`: stop. The bound wallet's live A-Pass or policy-pool eligibility is insufficient. Ask the institution administrator to refresh or repair compliance.
- `CVA_NOT_ISSUED`, `CVA_PAUSED`: stop. Do not substitute a token based only on symbol or address resemblance.
- `ASSET_NOT_ENABLED`: refresh `list_verified_assets`; the asset is not accepted by the active deployment.

## Economic and lifecycle errors

- `INSUFFICIENT_BALANCE`: re-read portfolio/vault data. Never reduce an amount without user authorization.
- `INSUFFICIENT_ALLOWANCE`: a prepared intent may include an exact approval step. If execution partially completed, inspect status before preparing again.
- `ORACLE_STALE`: do not bypass freshness. Wait for an authorized valuation refresh and prepare a new intent.
- `OFFER_NOT_OPEN`, `POSITION_NOT_ACTIONABLE`, `AUCTION_NOT_ACTIVE`: refresh the relevant read model; another transaction or chain time changed the lifecycle.
- `QUOTE_EXPIRED`, `INTENT_EXPIRED`: prepare a new intent with a new UUID and present changed economics again.
- `MAX_PRICE_EXCEEDED`, rate, duration, LTV, or notional bounds: stop and report the signed-mandate or risk limit that blocked execution.

## Policy and authorization errors

- `INSUFFICIENT_SCOPE`: the credential was not granted that capability. Ask an administrator to issue or rotate a least-privilege credential.
- `AGENT_PAUSED`, `AGENT_REVOKED`, `MANDATE_REQUIRED`, `MANDATE_EXPIRED`: stop; only the institution administrator can restore authority.
- `APPROVAL_REQUIRED`: do not repeatedly call execute. Hand the immutable intent to the administrator.
- `INTENT_HASH_MISMATCH`: treat as a security incident. Do not execute; compare against the original preparation result.
- `IDEMPOTENCY_CONFLICT`: query the existing intent associated with that key. Never repurpose a UUID for different inputs.

## Ambiguous execution

If a tool times out, disconnects, or returns a transport error after prepare or execute:

1. Preserve the original idempotency key, intent ID, and intent hash.
2. Call `get_execution_status` for the known intent.
3. If no intent ID was received, retry the same prepare request with the same idempotency key.
4. If state is `SUBMITTED`, `CONFIRMED`, or `INDEXING`, poll. Do not prepare or execute another operation.
5. If state is `FAILED_WITH_ALLOWANCE`, assume an ERC-20 approval may be final. Re-read allowance/balance through a newly prepared operation only after reporting the partial outcome.
6. If state is terminal, report its error and transaction hashes. A new semantic attempt needs a new UUID.

`AMBIGUOUS_SIGNING_OUTCOME` means the executor durably crossed the signing boundary, then institutional authority changed before it could prove whether Privy submitted the transaction. Stop automation and have an operator reconcile the Privy action log, Monad history, wallet nonce, allowances, and indexed RWCAR activity before authorizing any new intent.

## Reporting

Report facts separately:

- Prepared: policy and preflight snapshot only; no chain change.
- Submitted: transaction hash exists; not final.
- Confirmed: receipt exists; indexer projection may lag.
- Completed: finality and institutional ledger projection both passed.

Always include correlation IDs for support, but never include OAuth tokens, client secrets, Privy authorization keys, Cleanverse API keys, or wallet private keys.
