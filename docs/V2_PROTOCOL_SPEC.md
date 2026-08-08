# RWCAR V2 protocol specification

This document is the implementation contract for the versioned RWCAR V2 release. V1 remains an immutable Direct-DvP market and is never migrated in place.

## Module boundaries

- `RepoMarketV2` owns offer and isolated-position state transitions.
- `CollateralVaultV2` is a single-CVA custody ledger. Users reach it through the market; only authorized protocol modules may reserve or release collateral.
- `SettlementEscrowV2` holds only aUSDC and exposes pull claims when a beneficiary cannot receive a direct compliant transfer.
- `SignedValuationOracle` accepts unique, ordered 2-of-3 EIP-712 signer attestations with an increasing nonce and validity deadline.
- `RiskManagerV2` stores bounded, timelocked asset and market risk parameters.
- `DutchAuctionV2` liquidates one isolated position or one cross-margin account at a time.
- `MarginEngineV2` owns opt-in, same-CVA master netting sets. It does not change isolated repo accounting.
- `ProtocolModuleFactoryV2` records every child controller/token/type binding and exposes the only contract-CVI registration path, restricted to its owner and exact factory-deployed vaults/escrows.

Financial-core deployments are immutable. A new version is deployed for logic changes. Governance may change only explicitly bounded parameters and may pause new exposure; it cannot seize accounted assets or block exits.

## Cleanverse tri-party guide conformance

The supplied three-page tri-party vault guide is treated as a release requirement, not merely a design suggestion:

| Guide requirement | V2 implementation |
|---|---|
| The vault, never the market, holds CVA collateral | Each enabled CVA receives a dedicated `CollateralVaultV2`; the market stores accounting references only. |
| Users cannot mutate vault accounting directly | Every vault mutation is restricted to its immutable controller. |
| Repurchase and default settlement should be atomic | Payment state and collateral state change in the same market transaction or both revert. |
| Register the custody address with Cleanverse before use | A new vault starts `cleanverseReady = false`; governance can enable it only after registration and a real transfer smoke test are recorded. |
| Preserve the existing Direct-DvP path | V1 remains deployed and independently indexed; V2 is additive and does not migrate V1 positions. |
| Keep cross-margin out of the simple custody vault | Cross-margin is an opt-in engine with its own isolated controller/custody boundary; it cannot reuse isolated-position collateral. |

## Token and compliance model

Every state transition is described as both a participant graph and a token-transfer graph.

The market checks economic participants with the confirmed validator surface:

```solidity
complianceVerify(policyPool, participant)
```

The API separately calls Cleanverse for the exact A-Token on every transfer edge. Both the sender and receiver of RWRN01 or aUSDC must receive verification code `4`. The A-Token transfer hook remains the final token-level authority.

Before a vault or escrow is enabled:

1. Bind the issued Cleanverse application to the exact Monad chain and token address.
2. Confirm the token is `ISSUED`, unpaused and governed by the expected rules.
3. Register the market/engine policy pool through the encrypted Cleanverse API.
4. Grant `REGISTER_ROLE` to the exact factory using the plaintext message `monad` plus the lowercase factory address and the live factory owner's EIP-191 signature.
5. Call `registerApass(policyPool, aToken, custodyAddress)` through `registerCvaCustody` for every exact vault/CVA and escrow/settlement-A-Token pair.
6. Transfer a small amount into and out of the contract with real UAT tokens.
7. Store every transaction hash, exact binding, and policy snapshot in release evidence.

No rule-management function from a mismatched live ABI is called on-chain. Rules are administered through the confirmed Cleanverse API.

## Vault accounting

A vault is deployed for exactly one CVA. Its accounting namespaces are:

```text
available[owner]
offerReserved[offerId]
positionLocked[positionId]
auctionLocked[auctionId]
marginLocked[accountId]
```

The required solvency invariant is:

```text
sum(available + reserved + position + auction + margin liabilities)
    <= ERC20.balanceOf(vault)
```

Creating an offer reserves its full collateral. A fill moves only its allocation into a position. Cancelling or expiring an offer returns only the remaining reservation. Repayment credits the seller's available balance. Default moves the exact position allocation to an auction or lender claim. No accounted balance is available to a rescue function.

Nominal transfer amounts must equal observed balance deltas. Fee-on-transfer and rebasing assets are unsupported.

## Offers, fills and fees

Offers and positions are different records. An offer contains total and remaining principal/collateral, minimum fill, commercial terms, valuation reference and permitted buyer. Every fill creates a non-transferable position with its own buyer, allocation, accepted timestamp, maturity and deadline.

For cumulative filled principal `F`:

```text
cumulativeCollateral(F) = floor(totalCollateral * F / targetPrincipal)
fillCollateral = cumulativeCollateral(F_after) - collateralAllocatedBefore
```

The final fill receives all remaining collateral dust. A fill must meet the offer minimum unless it consumes the complete remaining principal, and it must never allocate zero collateral.

Opening fees are split-independent:

```text
cumulativeFee(F) = ceil(F * protocolFeeBps / 10_000)
fillFee = cumulativeFee(F_after) - feeChargedBefore
```

The buyer pays the gross fill principal. Treasury receives `fillFee`; the seller receives `fillPrincipal - fillFee`; the position debt principal is the gross fill principal.

## Interest and repayment

All annualized calculations use ACT/365 and ceiling rounding with overflow-safe full-precision multiplication.

```text
scheduledInterest = ceil(principal * repoAprBps * duration / (10_000 * 365 days))
```

For an early-enabled offer:

```text
accrualTime = max(now - acceptedAt, minimumHoldSeconds)
accrued = ceil(principal * repoAprBps * accrualTime / annualDenominator)
breakFee = ceil(principal * breakFeeBps / 10_000)
earlyCompensation = min(scheduledInterest, accrued + breakFee)
earlyPayoff = principal + earlyCompensation
```

At maturity, the full scheduled payoff is due. Default interest starts at maturity and accrues until repayment or auction start. Repayment is allowed throughout the grace window. Starting an auction freezes debt and irreversibly closes the repayment path for that position.

Direct repayment sends aUSDC to an eligible lender. The seller may instead force the alternative escrow path, and the API selects it automatically when the lender cannot currently receive a direct transfer; this sends the same payoff to `SettlementEscrowV2` and creates a pull claim. In either path the collateral is atomically released to the seller's available vault balance.

## Default auction

After the repayment deadline, anyone may start the Dutch auction using a fresh accepted valuation. The debt and valuation snapshot are frozen for that auction.

```text
startPrice = max(frozenDebt, oracleValue * startPriceBps / 10_000)
floorPrice = oracleValue * floorPriceBps / 10_000
price(t) = startPrice - (startPrice - floorPrice) * elapsed / duration
```

The first eligible buyer accepting the live price and a caller-supplied maximum price settles atomically. Proceeds pay lender debt first, liquidation cost second and seller surplus last. Any lender shortfall is recorded.

If the auction expires unsold, the lender may claim the exact allocated CVA to a compliant address. A frozen lender retains an in-vault claim. A stale oracle blocks auction creation; after the configured stale-oracle fallback delay, the lender may elect an in-kind claim.

## Cross-margin accounts

Cross-margin accounts are explicit master netting sets with one seller, one CVA, one settlement token and one policy pool. Multiple repo exposures may share account collateral, but that collateral cannot secure obligations outside the account.

The seller defines a non-revolving funding mandate at account creation:

```text
fundingTarget, minimumFunding, maxAnnualRateBps,
fundingDuration, fundingExpiry, optional permittedLender
```

Each fill must fit the unfilled target, meet the minimum unless it is the final remainder, use a rate no greater than the seller's ceiling, arrive before expiry, and satisfy the optional lender restriction. The lender cannot alter duration or expiry. Funding closes permanently when the target is reached or the seller closes the mandate.

```text
exposureFaceDebt = principal + ceil(full-term interest)
LTV = sum(active exposure face debt) / fresh oracle collateral value
```

Initial RWRN01 parameters are 70% maximum opening LTV, 75% margin-call LTV and 80% liquidation LTV. Funding rechecks live registry admission, the stricter of snapshotted and live opening LTV/oracle-age limits, both participants' compliance, and exact settlement-token deltas. Withdrawals require opening health. Deposits and repayments remain available during a margin call. An uncured call, liquidation-threshold breach, or one exposure passing its repayment deadline cross-defaults the account.

Liquidation freezes aggregate debt and active-exposure count once, then distributes recovery pari passu by fixed face debt. Claims are pull-based and constant-time; no state transition loops over all lenders. The final claimant receives any deterministic rounding dust. When a shortfall rounds a tiny allocation to zero, that exposure can still be closed so it cannot deadlock later claims.

## Required safety properties

- An offer can never be overfilled.
- A collateral unit belongs to only one accounting namespace.
- Fully filled offers allocate exactly all collateral.
- Fee totals do not depend on fill splitting.
- Every position reaches one terminal outcome and releases collateral once.
- Failed external transfers revert accounting changes.
- Pausing blocks new risk but never repayment, deposits that cure risk, withdrawals of free balances, claims or liquidation.
- Oracle signatures are domain-separated, unique, non-expired and non-replayable.
- Compliance failure leaves funds recorded, recoverable and unmoved; it never silently bypasses policy.
- No user-supplied array can create an unbounded settlement loop.
- A seller-authored margin funding mandate cannot revolve, grow, extend, or be repriced above its ceiling by a lender.
- Once liquidation freezes an account, individual repayment cannot mutate its pro-rata denominator.

## Release gates

1. Local unit, fuzz and invariant suites pass.
2. Multi-contract indexer replay and reorg tests pass.
3. API preflight evaluates all participants and exact token edges.
4. Real Monad UAT covers vault deposit/withdraw, two fills, early repayment, direct and escrow repayment, auction purchase, auction failure claim, margin call/cure and cross-default.
5. Vault balances reconcile to liabilities after every acceptance scenario.
6. All previously disclosed credentials are rotated.
7. Production requires Cleanverse authorization, legal approval of custody/netting terms and an independent audit with no unresolved critical or high findings.
