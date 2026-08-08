# RWCAR API

The API is a fail-closed transaction-intent service and confirmed-chain read model. It never signs protocol transactions. All writes use JSON with strict Zod/Fastify validation. Errors contain `code`, `message`, and a UUID `correlationId`.

## Authentication and units

Public read routes do not require authentication. Every `/v1/preflight/*` and `/v2/preflight/*` route requires `Authorization: Bearer <Privy access token>`. The `actor` or `seller` in the body must be a wallet linked to that Privy user.

Token amounts are unsigned base-unit decimal strings. Timestamps in request bodies are Unix seconds. Rates and fees are basis points. Addresses are 20-byte EVM addresses.

An eligible preflight returns:

- authoritative compliance and transfer-edge results;
- required ERC-20 approvals with exact token, spender, and amount;
- unsigned wallet transactions with exact destination, calldata, and native value;
- a block-bound quote with `quoteId`, amounts, projected state, and expiry;
- a correlation ID suitable for logs and support.

Clients must verify the returned destinations/selectors, execute only the listed approvals, and run the preflight again after approvals. The contract and current Cleanverse state remain authoritative if conditions change before inclusion.

## Public V1 reads

- `GET /health`
- `GET /v1/config` — public chain, deployment addresses, fee, and enabled durations.
- `GET /v1/assets` — only locally enabled assets whose live Cleanverse application status is `ISSUED`.
- `GET /v1/offers` — confirmed open offers from the indexer.
- `GET /v1/positions/:wallet` — confirmed positions involving a wallet.

## V1 preflights

- `POST /v1/compliance/verify` — `{ wallet, asset }`.
- `POST /v1/preflight/create` — seller, asset, atomic amounts, rate, duration, expiry, optional permitted buyer, and valuation hash.
- `POST /v1/preflight/accept` — `{ actor, repoId }`.
- `POST /v1/preflight/repurchase` — `{ actor, repoId }`.

## Public V2 reads

- `GET /v2/config` — finalized chain time/block, immutable module addresses, allowed durations, admitted CVA records with live per-asset vault proofs, feature flags, and fail-closed `readiness.operatorAttestations`. Treat `features.*` as the UI gate; an address or on-chain readiness bit alone is not operational readiness.
- `GET /v2/offers` — `{ offers, asOf }` containing confirmed `OPEN` and `PARTIALLY_FILLED` offers that remain fillable.
- `GET /v2/offers/:offerId` — one projected offer.
- `GET /v2/offers/:offerId/quote?principalAmount=<atomic>` — indicative cumulative partial-fill allocation and fee calculation. The authenticated fill preflight is the executable quote.
- `GET /v2/positions/:wallet` — `{ positions, sellerOffers, sellerOfferHistory }` from confirmed events.
- `GET /v2/positions/:positionId/payoff[?timestamp=<seconds>]` — current payoff using `previewPayoff` when RPC is available, otherwise a clearly labelled projection fallback.
- `GET /v2/vault/:wallet/balances` — projected bucket balances plus live `availableBalance` reads for every known vault.
- `GET /v2/auctions[?includeClosed=true|false]` and `GET /v2/auctions/:auctionId` — list response is `{ auctions, asOf }`; the detail route includes live price while open.
- `GET /v2/margin/accounts/:wallet` — opt-in cross-margin accounts and exposure state.
- `GET /v2/claims/:wallet` — settlement-escrow claims for a beneficiary.
- `GET /v2/system/status` — chain head, projection checkpoints, job health, and observation time.
- `GET /v2/activity[?wallet=0x...&limit=1..20]` — recent confirmed V2 activity for institutional dashboard/audit views.
- `GET /v2/transactions/:txHash/status` — whether a submitted transaction is observed, finalized, and projected. The UI should not describe a transaction as indexed before this route confirms it.

All read-model results are confirmation-delayed. Use `finalized.chainTimestamp` from `/v2/config`, not the browser clock, for action visibility near exact maturity, grace, and auction boundaries.

## V2 preflights

### Vault and offer lifecycle

- `POST /v2/preflight/deposit` — `{ actor, asset, amount }`.
- `POST /v2/preflight/withdraw` — `{ actor, asset, amount, recipient? }`.
- `POST /v2/preflight/create-offer`:

```json
{
  "seller": "0x...",
  "asset": "0x...",
  "permittedBuyer": null,
  "totalCollateral": "1000000",
  "targetPrincipal": "700000",
  "minimumFill": "100000",
  "annualRateBps": 575,
  "durationSeconds": 604800,
  "offerExpiry": 1786200000,
  "earlyRepurchaseEnabled": true
}
```

- `POST /v2/preflight/fill` — `{ actor, offerId, principalAmount }`. Allocation and fee use cumulative pro-rata accounting; the final fill receives rounding dust.
- `POST /v2/preflight/cancel-offer` — `{ actor, offerId }`.
- `POST /v2/preflight/finalize-offer-expiry` — `{ actor, offerId }`; permissionless on-chain but still authenticated and simulated by the API.

### Position, default, and settlement lifecycle

- `POST /v2/preflight/repay` — `{ actor, positionId, maxPayoff? }`. `maxPayoff` is a caller-approved ceiling, not a quoted debit target.
- `POST /v2/preflight/start-auction` — `{ actor, positionId, valuationId? }`.
- `POST /v2/preflight/buy-auction` — `{ actor, auctionId, maxPrice? }`.
- `POST /v2/preflight/finalize-failed-auction` — `{ actor, auctionId }`.
- `POST /v2/preflight/claim-collateral` — `{ actor, positionId, recipient? }` for the lender path after a failed auction.
- `POST /v2/preflight/claim-oracle-fallback` — `{ actor, positionId, recipient? }` for the delayed in-kind path when a valid valuation remains unavailable.
- `POST /v2/preflight/claim-settlement` — `{ actor, claimId, amount, recipient? }`; supports partial pull claims and repeats current CVI checks.

### Cross-margin lifecycle

`POST /v2/preflight/margin-action` accepts an `actor`, an `action`, and only the IDs/amounts required by that action. Supported actions are defined by `MarginActionV2Schema` in `packages/shared/src/v2.ts` and include deposit/withdraw, account opening, collateral changes, funding, repayment, margin calls/cure, liquidation auction actions, claim materialization, failed-collateral claims, and account closure.

Cross-margin fails closed unless `V2_MARGIN_ENABLED=true` and the deployed margin engine has passed its independent custody/readiness gate. Do not enable the flag merely because an address exists.

The API also defaults these operator-evidence gates to false: `V2_REPO_POLICY_POOL_REGISTERED`, `V2_FEE_TREASURY_AUSDC_ELIGIBLE`, `V2_SETTLEMENT_ESCROW_AUSDC_READY`, `V2_MARGIN_POLICY_POOL_REGISTERED`, `V2_MARGIN_VAULT_CUSTODY_READY`, `V2_MARGIN_ESCROW_AUSDC_READY`, and `V2_MARGIN_TREASURY_AUSDC_ELIGIBLE`. They must map to reviewed manifest evidence; they are not convenience feature flags.

## Internal issuer plane

These routes are disabled unless `ADMIN_API_KEY` is configured and require `x-admin-key`.

- `POST /internal/v1/assets` validates `cleanverseRequestId` live and refuses any application not in `ISSUED` state.
- `POST /internal/v1/valuations` verifies an EIP-712 valuation signature against `VALUATION_SIGNERS`, stores the evidence snapshot, and publishes its hash to the enabled asset record.
- `POST /internal/v1/documents/:asset` accepts one multipart evidence file (25 MB maximum), computes SHA-256, stores it with S3/KMS or AES-256 server-side encryption, and records immutable hash metadata.

Cleanverse credentials, the admin credential, storage credentials, deployer keys, keeper keys, and oracle signer keys must never be present in the browser bundle.
