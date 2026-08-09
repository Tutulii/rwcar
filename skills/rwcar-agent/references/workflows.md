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
5. Determine principal, collateral, annual rate, duration, offer expiry, and optional permitted buyer from the user's objective and live protocol limits. The server resolves the authorized signed valuation.
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

1. Read `onChainStatus`, derived `lifecycleState`, oracle freshness, and `defaultAutomation` from `get_portfolio`. `OVERDUE` appears immediately after the grace deadline even while the authoritative on-chain enum remains `ACTIVE` until the keeper transaction lands.
2. The durable keeper calls the permissionless contract function directly. It does not create an agent intent and never needs administrator approval. When `defaultAutomation.executionMode` is `DIRECT_PERMISSIONLESS_ONCHAIN`, monitor its job state and the event stream; do not prepare an intent merely to unblock it.
3. Only when a human explicitly requests manual acceleration may a seller, lender, or third-party agent whose signed mandate includes `START_AUCTION` call `prepare_position_action`. Do not provide or invent a valuation ID; RWCAR resolves the current signed valuation server-side. This separate manual-agent path is risk-sensitive and must receive human approval.
4. Auction buyer calls `list_auctions`, then `prepare_auction_action` with `BUY` and a protective `maxPrice`.
5. RWCAR uses first successful fill at the live Dutch price, not a multi-bid order book. Another buyer may win first.
6. If no purchase occurs by the deadline, call `prepare_auction_action` with `FINALIZE_FAILED`, then use the position claim path indicated by portfolio state.

Manual auction starts, auction purchases, and other liquidation-risk agent actions are expected to require human approval even when notional is below the automatic threshold. Autonomous keeper execution is not an agent action.

## Shared-collateral margin

1. Call `get_margin_accounts`. Read `collateralSources`, `fundableAccounts`, and the returned numbered workflow before preparing a write.
2. Seller prepares `DEPOSIT` first. Use `collateralSource=AUTO` to consume wallet inventory and, if needed, compose an approved Repo Vault `AVAILABLE` sweep; use `WALLET` or `REPO_VAULT` only when the source is explicitly required.
3. After deposit completion, seller prepares `OPEN_ACCOUNT` to reserve margin-vault `AVAILABLE` collateral into a netting set.
4. An eligible non-seller lender selects the account from `fundableAccounts` and prepares `FUND_ACCOUNT`.
5. Read collateral, debt, LTV, oracle freshness, margin-call deadline, and exposures before every later action. Margin actions remain human-approved.
6. After repayment or liquidation, use `get_portfolio` and `get_margin_accounts` to find settlement claims and withdraw through `prepare_claim`.

## Human approval handoff

When an intent reports `APPROVAL_REQUIRED`, provide the administrator:

- agent name and wallet;
- action and affected on-chain resource;
- exact token amounts and rate/duration terms;
- destination contracts and selectors;
- intent ID, immutable intent hash, and expiry;
- why policy required approval.

Use the returned `approvalHandoff.challengeEndpoint` and `submissionEndpoint` only through the authenticated institution administrator flow. The administrator signs the challenge in the RWCAR Agent Console. After approval appears in the SSE feed or `get_execution_status`, call `execute_intent` with the original hash.
