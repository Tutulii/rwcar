# Threat model and controls

## Protected assets

- CVA collateral and aUSDC settlement balances
- Cleanverse credentials, Privy app secret, internal issuer credential, database and storage credentials
- Compliance decisions, valuation evidence, raw chain events, and audit records

## Principal threats

- Unauthorized or expired identity: API and contract both fail closed. Contract state changes use `complianceVerify`; CVA transfer hooks add another enforcement layer.
- Fake/unissued collateral: only registry-enabled CVAs can be offered; internal registration independently confirms Cleanverse `ISSUED` status.
- API impersonation: access tokens are verified with Privy and actor addresses must be linked to the authenticated user. Wallet signatures remain mandatory for every chain mutation.
- Stale preflight/race conditions: results expire after 30 seconds and do not authorize a transaction. The contract repeats all critical checks.
- Reentrancy/non-standard tokens: atomic transfer functions use `ReentrancyGuard` and `SafeERC20`; only explicitly reviewed CVAs and the fixed settlement token are admitted.
- Rounding manipulation: fee and interest use ceiling rounding in both API and Solidity, tested against the same vector.
- Indexer duplication/reorg: event identity is unique and checkpoint hashes are verified. A detected reorg triggers a deterministic rebuild from deployment block.
- Admin key compromise: entry pause can stop new exposure but cannot block cancellation, repayment, or permissionless default. Ownership uses a two-step handoff and should move to a multisig in production.
- Valuation forgery: snapshots require two distinct authorized signers from a three-member EIP-712 signer set; the complete canonical snapshot and evidence reference are hashed.
- Secret exposure: backend values have no `VITE_` prefix, logs redact authorization/internal headers, and `.env` files are ignored.
- Frontend/API substitution: a reviewed build-time manifest pins all V2 addresses and runtime-code hashes. The browser rejects mismatched API config, runtime drift, unknown destinations/selectors, altered calldata, native value, and non-exact approvals before opening the wallet.
- Duplicate signing after receipt/indexer delay: submitted hashes are persisted across reloads and remain action-locked until chain receipt and finalized projection reconciliation. Storage failure is surfaced as a submitted-transaction condition with the hash, never as a normal retryable error.
- Agent prompt injection or tool misuse: the machine interface has no arbitrary transaction tool. Signed mandates constrain assets/actions/rates/durations/counterparties/recipients/notional, risky actions require a separate administrator signature, and the executor verifies fixed destinations/selectors plus live preflight before signing.
- Agent credential theft: OAuth secrets are scrypt-hashed, tokens are short-lived and audience-bound, and every call rechecks live credential/agent/CVI/mandate state. Pause/revoke cancels unsubmitted intents under the same authority lock.
- Agent signer compromise: the authorization private key is isolated from API/web, Privy applies a deny-by-default policy, and the executor rejects imported/exported wallets or signer/policy/address drift. A compromised signer cannot call unlisted contracts or bypass on-chain compliance.
- Ambiguous machine execution: semantic UUID idempotency, Privy idempotency keys, immutable step hashes, per-wallet leases, and receipt/index reconciliation prevent a timeout from authoring a second operation.
- Dependency supply chain: production audits block on high or critical findings. The current reviewed transitive disposition is recorded in [DEPENDENCY_AUDIT.md](DEPENDENCY_AUDIT.md), including its platform and reachability constraints.

## V2 custody and market risks

- Vault insolvency or double reservation: every collateral unit has exactly one ledger namespace; deposits use exact balance deltas; invariant tests and an independent reconciler compare liabilities with token balances.
- Partial-fill rounding extraction: collateral and protocol fees use cumulative allocation, with the final fill receiving residual dust. Splitting an order cannot change aggregate economics.
- Frozen beneficiary blocking settlement: direct transfers remain the default, while seller-selected repayments and liquidation proceeds can become pull claims in a Cleanverse-approved aUSDC escrow. Governance cannot redirect claims.
- Stale or forged valuations: risk actions require a non-expired 2-of-3 EIP-712 quorum, unique signers, domain separation, and a strictly increasing asset nonce. Stale data blocks new borrowing and risk-increasing collateral withdrawal while free-balance exits remain available.
- Auction manipulation: the price path and frozen debt are deterministic; callers set a maximum price; bidders and recipients are rechecked at settlement; no privileged keeper selects the winner.
- Cross-margin contagion: accounts are opt-in, same-CVA master netting sets with explicit LTV bands, aggregate collateral limits, cross-default, and pari-passu recovery. Isolated positions never enter a margin account after opening.
- Lender-authored margin expansion: the seller signs the target, minimum fill, rate ceiling, fixed duration, expiry, and optional lender restriction. Funding is non-revolving, live risk is rechecked, and liquidation freezes the pro-rata denominator before any claim.
- Unbounded creditor loops: liquidation and repayment credit pull claims; settlement does not iterate through arbitrary lender arrays.
- Malicious administration: immutable core logic has no upgrade key, parameter changes are bounded and delayed, emergency pause affects new risk only, and accounted vault assets have no rescue path.
- Registrar-role abuse: the factory can request contract CVI only for vault/escrow children it deployed whose recorded controller and token exactly match the submitted pool/token. Auctions and arbitrary addresses are rejected, duplicate registrations revert, and the factory has no asset-transfer authority. A fresh activation EOA is retired through a two-step handoff to governance after registration evidence is final.
- Automation failure: lifecycle functions are permissionless and time-derived. Durable keeper jobs improve liveness but are never the sole authority for expiry, default, auction settlement, or margin calls. The keeper commits exact signed bytes/hash/nonce before broadcast; restart recovery can rebroadcast only that envelope and cannot author a second call.

## Known UAT condition

Every private key and API/storage/application secret previously shared in chat must be considered compromised. The deployment script refuses the known exposed deployer and requires a fresh deployer plus a separate pending owner. Rotate all credentials before any new environment or deployment; never fund or reuse exposed keys outside disposable testnet cleanup.

## Production gates

Independent Solidity audit, Cleanverse approval for every custody endpoint, multisig/delayed governance, monitored RPC redundancy, managed KMS/object storage, database PITR, vault reconciliation, oracle signer separation, alerting, incident rehearsal, legal approval of escrow/netting terms, and removal of UAT-only timing are mandatory before mainnet.
