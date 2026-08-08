# RWCAR engine architecture

RWCAR is a compliant repo protocol on Monad Testnet. The chain is the transaction source of truth; PostgreSQL is a confirmation-delayed, fully rebuildable read model. V2 is an immutable deployment beside V1 and adds custody-backed partial fills, early repurchase, signed risk valuation, default auctions, settlement pull claims, and opt-in single-CVA cross-margin. No V1 position is copied or rewritten.

The normative V2 economics, state machines, rounding rules, and invariants are defined in [V2_PROTOCOL_SPEC.md](V2_PROTOCOL_SPEC.md).

## System boundaries

1. The React client obtains a Privy access token, reads confirmed state, requests a short-lived fail-closed preflight, validates the returned destinations/selectors, and asks the connected wallet to sign exact approvals and protocol calls. It receives no backend, Cleanverse, storage, deployer, keeper, or oracle secret.
2. The API verifies the Privy token and linked actor, queries live Cleanverse CVI/CVA state, calls the Monad validator, checks token balances/allowances and on-chain protocol previews, builds the complete transfer graph, simulates calldata, and returns unsigned intents. It has no protocol signing key.
3. The immutable contracts repeat the authoritative access, compliance, state, timing, slippage, accounting, and transfer checks. A successful API preflight cannot force a stale or invalid chain transition.
4. The indexer waits for confirmations, scans every manifest-recorded module, stores raw logs idempotently by chain/transaction/log index, detects checkpoint reorgs, and projects offers, positions, vault buckets, auctions, settlement claims, valuations, risk changes, and margin accounts.
5. A separate gas-limited keeper executes only permissionless lifecycle calls from durable jobs after every source reaches the finalized gate. It has no ownership or asset withdrawal authority.
6. PostgreSQL, object storage, and API caches are evidence/read planes. They cannot create, fund, settle, liquidate, or rewrite an on-chain repo.

## V2 deployment topology

```text
Governance multisig / timelock
├── ProtocolModuleFactoryV2 ── constrained child deployer + contract-CVI registrar
├── CvaAssetRegistry
├── RiskManagerV2 ── delayed per-CVA risk tuples
├── SignedValuationOracle ── 2-of-3 EIP-712 attestations
├── RepoMarketV2 (isolated repo policy pool)
│   ├── CollateralVaultV2[RWRN01] (one immutable CVA)
│   ├── DutchAuctionV2
│   └── SettlementEscrowV2[aUSDC]
└── MarginEngineV2[RWRN01] (separate policy pool)
    ├── CollateralVaultV2[RWRN01] (not shared with market)
    ├── DutchAuctionV2
    └── SettlementEscrowV2[aUSDC]

Activation ceremony: a fresh EOA temporarily owns only ProtocolModuleFactoryV2,
signs its Cleanverse registrar proof, performs exact custody registrations, then
hands factory ownership to governance.
```

The factory records every child module's controller, token, and type. Its owner can call `registerApass(pool, token, custody)` only when those live bindings exactly match and the child is a vault or escrow; auctions are rejected. The factory cannot transfer or account for assets. The isolated market deploys one vault per admitted CVA. The current margin deployment is one immutable CVA per engine, so adding another collateral type requires another margin engine and separate Cleanverse activation. Vaults are never shared between isolated repo and cross-margin.

## V1 Direct-DvP continuity

V1 is the direct delivery-versus-payment fallback and historical close path:

- create records an offer while the seller retains title;
- accept atomically transfers aUSDC buyer-to-seller/treasury and CVA seller-to-buyer;
- repurchase atomically transfers payoff seller-to-buyer and CVA buyer-to-seller;
- after grace, permissionless default finalization leaves the already-delivered CVA with the buyer.

V1 has no vault or settlement escrow. Its indexer, keeper, and close paths remain operational while V1 exposure exists.

## Isolated V2 repo lifecycle

### Prefunding and offer reservation

The seller approves the per-CVA vault and calls the market deposit path. The vault performs an exact-balance-delta transfer and credits `AVAILABLE`. Offer creation moves the full offered collateral into `OFFER_RESERVED`; collateral cannot back another offer or margin account.

The market checks registry admission, vault readiness, seller CVI, duration/expiry, the current delayed risk tuple, and a fresh 2-of-3 signed valuation. A permitted-buyer address may restrict filling.

### Partial fills and opening cash settlement

Each fill creates an independent position with its own lender, acceptance time, maturity, collateral allocation, opening valuation digest, and snapshotted closeout/early-repurchase terms. Collateral allocation is cumulative pro-rata, not per-fill division:

`allocated(cumulativePrincipal) = floor(totalCollateral × cumulativePrincipal / targetPrincipal)`

The final fill receives allocation dust. Opening protocol fees are also cumulative and ceiling-rounded, so splitting a principal amount cannot reduce total fees. aUSDC moves from buyer to seller and to an eligible treasury (or a treasury pull claim in the settlement escrow); the market never holds opening cash. The corresponding CVA moves only between vault accounting buckets.

### Repayment and early repurchase

Every position accrues independently using ACT/365. If enabled, repurchase is available before maturity, but chargeable accrual time is floored at the snapshotted minimum-hold fraction; accrued interest plus the break fee is capped at scheduled term interest. After maturity, the snapshotted default rate applies until repayment or auction start.

The seller supplies a `maxPayoff` ceiling. Collateral returns from `POSITION_LOCKED` to the seller's vault `AVAILABLE` balance. An eligible lender receives aUSDC directly; the seller may force escrow, and preflight selects it automatically when direct lender receipt is unavailable. The full amount then transfers to `SettlementEscrowV2` and becomes a beneficiary-specific pull claim. Claim withdrawal repeats beneficiary and recipient compliance and supports partial amounts.

### Default and Dutch auction

After the strict grace deadline, anyone may start closeout with a fresh valuation. Debt and risk inputs freeze, collateral moves to `AUCTION_LOCKED`, and a deterministic linear Dutch price clock starts. A buyer supplies a maximum acceptable price.

The complete price transfers buyer-to-settlement escrow exactly once. The controller records separate lender, liquidation-fee, and seller-surplus claims; any debt shortfall is explicit. Only after settlement does the vault deliver the CVA to the compliant buyer. If the auction expires unsold, the lender can claim collateral in kind. If a valuation remains unavailable beyond the bounded stale-oracle delay, the lender has a separate in-kind escape path that succeeds only while the oracle is still unusable.

## Cross-margin lifecycle

Cross-margin is opt-in, single-seller, single-CVA, single-settlement-token, and single-policy-pool. An account reserves collateral in the margin vault. At opening the seller signs a non-revolving funding mandate containing the target principal, minimum fill, maximum annual rate, fixed duration, funding expiry, and optional permitted lender. A lender may improve the rate but cannot enlarge or extend the mandate. Funding stops permanently when the target is reached or the seller closes it; expired mandates cannot be funded.

Each lender-funded exposure records immutable lender, principal, fixed face debt, duration, maturity, and status. The fixed face debt is principal plus the disclosed full-term interest for that fill. Aggregate fixed face debt enables O(1) health checks without iterating lenders and makes the liquidation denominator deterministic.

Fresh signed valuation and the account's snapshotted thresholds determine LTV. Above maintenance, anyone may open a bounded margin call. The seller cures by adding collateral or reducing debt; an uncured call, liquidation-threshold breach, or matured payment default can liquidate the entire netting set.

Successful liquidation sends the complete auction price to the margin escrow. Treasury/seller claims are recorded immediately. Each lender recovery is materialized permissionlessly, pro-rata to face debt, into a non-transferable escrow claim; the final exposure receives rounding dust. Failed-auction or stale-oracle closeout distributes CVA pro-rata, with final-claim dust and no unbounded lender loop. The account closes only when liabilities are zero.

There is no rehypothecation, cross-seller netting, cross-CVA netting, unsecured exposure, or transferable lender claim.

## Compliance architecture

- **CVI/A-Pass** proves that sellers, lenders/buyers, auction buyers, claim recipients, and treasury addresses are currently eligible for the selected A-Token and policy pool.
- **CVA/A-Token** proves collateral issuance. Its transfer hook independently checks both transfer endpoints, including contract custody addresses.
- **CCP validator** is called on-chain through the confirmed `complianceVerify(pool,user)` interface. Runtime code intentionally avoids the documentation-mismatched rule-management ABI.
- **Asset registry** is a local admission defense, not a replacement for Cleanverse `ISSUED` status or the token hook.
- **Readiness flags** are governance/operator attestations, not automatic authorization. On-chain custody flags and the API's separate policy-pool, treasury, vault, and escrow attestation flags all stay false until the exact addresses are registered and real transfer/reconciliation proofs are preserved. `/v2/config` combines these gates rather than trusting a configured address.

Market and margin vaults/escrows require separate Cleanverse registrations. A user's valid A-Pass cannot establish contract-custody eligibility.

## Oracle and risk governance

`SignedValuationOracle` accepts an EIP-712 payload bound to its deployment/domain, asset, settlement token, price, observation time, expiry, per-asset nonce, and evidence hash. Two different signers from a three-member set must sign. Nonces are single-use per asset, valuations can be explicitly invalidated, and signer-set replacement is delayed.

`RiskManagerV2` stores a delayed per-CVA tuple covering opening/maintenance/liquidation LTV, auction curve and duration, liquidation fee, early-repurchase terms, default spread/rate cap, maximum oracle age, margin-call period, and stale-oracle fallback delay. Schedule and apply must use the same tuple hash. Existing funded positions/accounts snapshot the terms needed for deterministic closeout.

## Accounting and custody invariants

- `CollateralVaultV2.totalAccounted` must never exceed its CVA balance.
- Every CVA unit is in exactly one owner/bucket/reference state: available, offer-reserved, position-locked, auction-locked, or margin-locked.
- A vault accepts only exact transfers; fee-on-transfer behavior reverts.
- The accounted CVA cannot be rescued. Direct CVA donations do not create user credit.
- `SettlementEscrowV2.totalClaims` must never exceed its settlement-token balance.
- Claims are recorded only against already-received, unaccounted escrow balance and retain immutable beneficiary/provenance.
- Neither `RepoMarketV2` nor `MarginEngineV2` holds settlement-token balances during normal flows.
- Position and exposure state changes occur before external transfers under reentrancy guards; any failed transfer reverts the full transaction.
- Rounding is deterministic and conserved; terminal allocation/claim receives dust exactly once.

## Availability and automation

Smart contracts do not wake up on their own. Confirmed events create durable permissionless jobs for offer expiry, isolated and margin auction start/finalization, payment-default declaration, stale-oracle fallback, and lender claim materialization. Workers lease jobs, simulate before submission, retry with bounded exponential backoff, and stop after a reviewed maximum. A finalized-source gate across every configured module prevents automation from outrunning projections or acting during a detected reorg.

Submission is a durable signed-transaction outbox, not an in-memory interval: `RUNNING -> SUBMITTED(signedBytes, txHash, nonce) -> SUCCEEDED`. Exact signed bytes and their deterministic hash are committed before first broadcast. A restart may rebroadcast only those identical bytes, so a crash or ambiguous RPC response cannot author a second call. Terminal reconciliation clears the signed envelope, and success requires the configured confirmation depth. The keeper destination allowlist binds each action to the manifest-pinned market or margin engine.

Automation is a liveness aid, never a privileged settlement party. Users or another keeper can call the same functions. Margin call/liquidation and claim-materialization paths remain permissionless even when not automatically submitted by the current worker.

## Browser signing boundary

The production frontend is built with a reviewed `VITE_TRUSTED_V2_MANIFEST_JSON`. The manifest pins chain ID, deployment identity, every controller/child/token/CVA address, and every runtime-code hash. A deployment script emits only a `DEPLOYED_NOT_ACTIVE` draft; operations may change only its status to `ACTIVE` after governance, Cleanverse custody, valuation, reconciliation, and smoke evidence pass.

At runtime the browser rejects API address substitution, contract-code drift, unexpected selectors/destinations, calldata that differs from the reviewed form, native value where none is expected, and approvals above the exact action amount. Submitted transaction hashes are persisted before receipt waiting. Unknown receipts and pending finalized indexing keep duplicate submission locked across reloads.

## Entry pause and failure behavior

The separate pause guardian can pause new entry immediately. Only governance can unpause, replace guardians, change treasury, apply risk, rotate oracle signers, or change readiness. Entry pause/readiness/registry disablement blocks new exposure but preserves withdrawals, cancellation, repayment, auctions, escrow claims, and lender recovery.

Cleanverse, RPC, oracle, indexer, or database uncertainty fails closed for new transactions. Read models may lag but cannot change chain state. Recovery uses recorded deployment blocks and raw logs; immutable contracts are never overwritten, and a rollback disables entry/features while preserving close paths.
