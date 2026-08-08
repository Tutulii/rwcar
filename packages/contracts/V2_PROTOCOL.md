# RWCAR Protocol V2

V2 is an immutable, versioned deployment beside `RepoMarketV1`. V1 positions and the Direct-DvP fallback are unchanged.

## Contract topology

- `RepoMarketV2` controls one `CollateralVaultV2` per admitted CVA, a `DutchAuctionV2`, and a `SettlementEscrowV2`.
- `MarginEngineV2` is a separate same-CVA master netting module. It deploys and controls its own vault, auction, and escrow. It never shares or expands the simple repo vault.
- `ProtocolModuleFactoryV2` deploys modules and records each child's immutable controller, token, and type. After Cleanverse grants the factory `REGISTER_ROLE`, its owner may register contract CVI only for those exact controller-bound vault/escrow modules; the factory never custodies assets.
- `SignedValuationOracle` accepts 2-of-3 OpenZeppelin EIP-712 signatures, evidence hashes, per-asset nonces, expiry, explicit invalidation, and delayed signer rotation.
- `RiskManagerV2` applies delayed configurations. Existing positions snapshot closeout parameters when funded.

No engine or market contract custodies settlement tokens. Auction proceeds go directly into the corresponding settlement escrow, while CVA collateral remains in the vault until repayment, sale, or an eligible lender claim.

## Cleanverse activation gate

`setAssetVaultReady` and `setCleanverseCustodyReady` are operational attestations, not substitutes for Cleanverse registration. Leave them false until all of the following are complete on the target chain:

1. Register `RepoMarketV2` and `MarginEngineV2` as compliance pools with the intended rules.
2. Grant `REGISTER_ROLE` to the exact module factory using the documented owner `personal_sign` proof.
3. Have the factory call `registerApass(policyPool, cva, vault)` for each CVA vault.
4. Have the factory call `registerApass(policyPool, settlementAToken, escrow)` for each settlement escrow.
5. Prove small real deposits and withdrawals for every exact vault and escrow address.
6. Record transaction hashes and the applied Cleanverse rule snapshot in the deployment manifest.

Disabling registry admission/readiness or pausing entry blocks new exposure only. Withdrawals, repayment, auctions, escrow claims, and lender recovery remain callable and still rely on live token hooks and compliance.

## Economics

- Oracle `priceE18` is the human settlement-token value of one whole CVA, scaled by `1e18`. Risk valuation returns settlement-token atomic units.
- Partial fills allocate collateral cumulatively: `floor(totalCollateral * cumulativePrincipal / targetPrincipal)`. The last fill receives all dust.
- Protocol fees are also cumulative, so splitting an order does not alter total fees.
- Each fill has an independent acceptance time and maturity.
- Early payoff uses ACT/365 with a snapshotted minimum hold and break fee, capped at scheduled term interest. After maturity, snapshotted default APR accrues until repayment or auction start.
- Default creates a linear Dutch auction. The complete price is escrowed once, then lender, fee, and seller waterfall claims are recorded.
- If no bidder buys, an eligible lender can claim the fill collateral. If the signed oracle remains unavailable past the bounded fallback delay, the lender may take the collateral in kind without an auction.

## Cross-margin boundary

Cross-margin accounts are opt-in and limited to one seller, CVA, settlement token, and compliance policy. The seller first commits to a non-revolving funding target, minimum fill, maximum APR, duration, expiry, and optional permitted lender; a lender cannot enlarge, extend, or reprice that mandate above its ceiling. Exposures store fixed face debt (principal plus disclosed term interest), enabling O(1) health checks and cross-default without lender loops. Liquidation recovery is materialized permissionlessly into per-lender escrow claims, with the final claim receiving rounding dust. Failed-auction CVA is distributed using the same final-claim dust rule. There is no rehypothecation or transferable lender claim.

## Operational automation

Keepers may call permissionless finalization functions, but receive no privileged asset access:

- `finalizeOfferExpiry`
- `startAuction` / `finalizeFailedAuction`
- `openMarginCall` / `startMarginLiquidation` / `finalizeFailedMarginAuction`
- `materializeLiquidationClaim`

The service persists a `SUBMITTED` signed-transaction envelope (exact bytes, hash, and nonce) before first broadcast and reconciles it after restart. Recovery may rebroadcast only the same bytes, never author a second call, and marks success only after configured confirmation depth.

Guardian roles can pause entry immediately. Only the owner/timelock can unpause or replace guardians. Deployments should transfer ownership to the approved multisig/timelock before activation.

## Verification

`npm test --workspace @rwcar/contracts` compiles with the production via-IR settings, enforces EIP-170/EIP-3860 size limits for every V2 deployable contract, preserves all V1 tests, and runs isolated-repo and cross-margin settlement scenarios. External Cleanverse registration and real Monad transfer proofs remain mandatory deployment gates and are intentionally not mocked by production contracts.
