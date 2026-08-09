# RWCAR agent workflows

## Connect and verify

1. Obtain the OAuth token endpoint and MCP endpoint from the RWCAR deployment operator.
2. Exchange `client_id` and `client_secret` with `grant_type=client_credentials`, `resource=<canonical MCP URL>`, and only the scopes granted to the credential.
3. Connect to the streamable HTTP MCP endpoint with `Authorization: Bearer <short-lived-token>`.
4. Call `get_protocol_info`. Stop if deployment trust, chain, or required module readiness is false.
5. Call `list_verified_assets`, then `check_eligibility` for each selected CVA.

Access tokens are intentionally short lived. Refresh by performing another client-credentials exchange; do not cache the client secret in model memory.

## Seller: deposit and create an offer

1. Choose a Cleanverse-issued asset from `list_verified_assets`.
2. Call `prepare_vault_action` with `DEPOSIT`, asset, amount, and a fresh UUID.
3. Inspect and execute the intent. It may contain an exact ERC-20 approval step followed by the vault deposit.
4. Wait for `COMPLETED`, then call `get_portfolio` and confirm available vault inventory.
5. Determine principal, collateral, annual rate, duration, offer expiry, optional permitted buyer, and valuation from the user's objective and live protocol limits.
6. Call `prepare_create_offer`, inspect its pro-rata and risk terms, execute, and wait for `COMPLETED`.
7. Confirm the new offer through `list_offers` or `get_portfolio`.

## Buyer: partial fill

1. Call `list_offers`, select an open finalized offer, and call `get_offer_quote` for the desired principal amount.
2. Re-check eligibility for both the CVA and the settlement path when returned by the protocol.
3. Call `prepare_offer_action` with `FILL`, the exact offer ID, desired principal, and a fresh UUID.
4. Check pro-rata collateral, payoff economics, maturity, allowance step, quote expiry, and counterparty constraints.
5. Execute only within the signed mandate and wait for `COMPLETED`.
6. Confirm the lender position in `get_portfolio`.

## Seller: early or normal repurchase

1. Read the position in `get_portfolio`; never derive the payoff locally.
2. Call `prepare_position_action` with `REPAY`, position ID, and a conservative `maxPayoff` if the tool requires one.
3. Inspect accrued interest, early-break fee, protocol fee, and claim-based settlement details.
4. Execute and wait for `COMPLETED`.
5. The lender calls `prepare_claim` for the indexed escrow claim, executes it, and confirms completion.

## Offer cancellation or expiry

- Seller cancellation: `prepare_offer_action` with `CANCEL` while the offer is open.
- Permissionless expiry finalization: `prepare_offer_action` with `FINALIZE_EXPIRY` only after chain time passes the offer deadline.
- After completion, verify reserved collateral returned to the appropriate vault bucket.

## Default and Dutch auction

1. Confirm the position's maturity and grace period using `get_portfolio`.
2. Call `prepare_position_action` with `START_AUCTION`; use only a fresh, valid valuation identifier returned by protocol data.
3. Inspect and execute only after any required human approval.
4. Auction buyer calls `list_auctions`, then `prepare_auction_action` with `BUY` and a protective `maxPrice`.
5. RWCAR uses first successful fill at the live Dutch price, not a multi-bid order book. Another buyer may win first.
6. If no purchase occurs by the deadline, call `prepare_auction_action` with `FINALIZE_FAILED`, then use the position claim path indicated by portfolio state.

Auction purchases and other liquidation-risk actions are expected to require human approval even when notional is below the automatic threshold.

## Shared-collateral margin

1. Call `get_margin_accounts` and select an on-chain account involving the agent wallet.
2. Read its collateral, debt, LTV, oracle freshness, funding mandate, margin-call deadline, and exposures.
3. Call `prepare_margin_action` with exactly one supported semantic action and a fresh UUID.
4. Margin actions are high risk and should remain human-approved.
5. After repayment or liquidation, use `get_portfolio` and `get_margin_accounts` to find settlement claims and withdraw through `prepare_claim`.

## Human approval handoff

When an intent reports `APPROVAL_REQUIRED`, provide the administrator:

- agent name and wallet;
- action and affected on-chain resource;
- exact token amounts and rate/duration terms;
- destination contracts and selectors;
- intent ID, immutable intent hash, and expiry;
- why policy required approval.

The administrator signs in the RWCAR Agent Console. After approval appears in `get_execution_status`, call `execute_intent` with the original hash.
