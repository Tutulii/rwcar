# Operations runbook

This runbook separates deployment from activation. A successful deployment is **not** a live market: entry remains paused, every custody-readiness flag remains false, the delayed risk configuration remains pending, and ownership remains pending until the governance multisig accepts it.

## Local and CI verification

```sh
npm install
npm run typecheck
npm test
npm run build
```

The Termux environment uses `solc-js` and Ganache because Hardhat's optional Android ARM64 analyzer is not published. CI retains the production Hardhat profile for Linux. The release build must use Solidity 0.8.24, optimizer 500 runs, and `viaIR: true`; record every init-code and compiled runtime-template hash from the V2 plan, then every actual deployed runtime-code hash from execution.

## Database and services

1. Provision PostgreSQL and set `DATABASE_URL` in the API and indexer secret stores.
2. Run `npm run db:migrate` once per environment before starting the new release.
3. Configure backend-only variables from `.env.example`. Never expose Cleanverse, Privy secret, database, storage, admin, keeper, deployer, or oracle signer credentials through `VITE_*`.
4. Run `npm run dev:api`, `npm run dev:indexer`, and `npm run dev` in separate terminals for local checks.
5. Check `GET /health`, `GET /v2/system/status`, every indexer source checkpoint, and the durable automation job queue.

The local browser is `http://127.0.0.1:5173`; the local API is `http://127.0.0.1:3001`.

## V1 continuity

V2 is deployed beside V1. Never point the V1 indexer at a V2 address, migrate live V1 positions into V2 storage, or disable V1 close paths. Keep the recorded V1 market, indexer source, and keeper operational until every V1 position is terminal. Entry-pause V1 only after V2 acceptance and an explicit governance decision.

## V2 pre-deployment gate

All boxes below are blocking:

- The release commit is immutable and the full build/test suite passes from a clean checkout.
- Contract init-code/runtime-code hashes and EIP-170/EIP-3860 size checks are recorded.
- A fresh, gas-limited, one-time UAT deployer is funded; its key has never appeared in chat, screenshots, shell history, a repository, or a server.
- A separate fresh EOA is designated as `V2_FACTORY_ACTIVATION_OWNER`. It owns only the constrained module factory during Cleanverse registration, has never exposed its key, and will transfer factory ownership to governance immediately afterward.
- The owner is a deployed Safe/multisig or timelock, separate from deployer, pause guardian, treasury, and all three oracle signers.
- Three distinct oracle signers are controlled by separate operators or custody policies; two signatures are required.
- The treasury and both UAT participants have live CVI/A-Pass eligibility for the settlement A-Token.
- The CVA has live `ISSUED` status; its chain/address/decimals and canonical issuance-reference hash are independently verified.
- Settlement A-Token and confirmed Cleanverse validator addresses are independently verified on Monad Testnet.
- Risk, fee, grace, duration, auction, oracle-age, margin-call, and stale-oracle parameters have named risk-owner approval.
- Every credential previously shared is rotated. No production-capable credential is reused for UAT.

## Generate and review the deployment plan

Populate only the public V2 deployment values in a one-time shell. Leave `V2_DEPLOY_MODE=plan` and do not provide a private key. Then run:

```sh
npm run deploy:uat:v2
```

The default command performs no network call and sends no transaction. It validates address/role separation and economic bounds, then prints constructor inputs plus artifact hashes. Compare the output to `deployments/monad-testnet-v2.template.json`; obtain engineering, risk, and operations approval before execution.

## Execute the V2 deployment

Execution is intentionally difficult to trigger accidentally. In the isolated one-time shell only:

1. Set `V2_DEPLOY_MODE=execute`.
2. Set `V2_DEPLOY_CONFIRM=DEPLOY_RWCAR_V2_TO_MONAD_TESTNET_10143`.
3. Set `V2_KEY_ROTATION_ATTESTATION=FRESH_UAT_KEYS_NOT_PREVIOUSLY_SHARED` only after completing the key-rotation check.
4. Provide `V2_UAT_DEPLOYER_PRIVATE_KEY`, matching `V2_DEPLOYER_ADDRESS`.
5. Set the public `V2_FACTORY_ACTIVATION_OWNER` address; its private key is never supplied to the deployment script or any server.
6. Re-run `npm run deploy:uat:v2` and capture stdout as a new, access-controlled release manifest plus stderr as the submitted-transaction journal.

The script verifies chain ID 10143, code at the CVA/settlement/validator addresses, token decimals, owner contract code by default, deployer balance, and fresh role separation. After deployment it also verifies actual runtime sizes/hashes, every child controller/asset/token/validator/policy-pool binding, the oracle signer set, pending ownership, pending risk hash/time, paused entry, and false custody-readiness gates. It then:

1. deploys `ProtocolModuleFactoryV2`, `CvaAssetRegistry`, `RiskManagerV2`, and `SignedValuationOracle`;
2. admits the issued CVA in the registry;
3. deploys `RepoMarketV2`, whose constructor creates its auction and settlement escrow;
4. configures the CVA, which creates the market's immutable-controller vault;
5. deploys `MarginEngineV2`, whose constructor creates a separate vault, auction, and escrow;
6. schedules, but does not apply, the delayed CVA risk configuration;
7. installs the separate pause guardian and pauses entry on both engines;
8. starts two-step ownership transfers for the registry, risk manager, oracle, market, and margin engine.

It does **not** call Cleanverse, apply risk, publish a valuation, assert custody readiness, unpause entry, enable the API margin flag, or accept ownership for the multisig.

If execution stops partway, do not blindly rerun it. Preserve every submitted transaction line, inspect receipts and deployed bytecode, update the partial manifest, and decide whether to resume manually or abandon the deployment with entry paused.

## Pending governance handoff and delayed configuration

The deployment starts two-step transfers for the registry, risk manager, oracle, market, and margin engine, but the pending multisig must **not** accept them until the Cleanverse owner-signature ceremony below completes. Cleanverse currently verifies EIP-191 signatures against live `owner()` addresses; accepting early could make the documented EOA signature flow impossible without confirmed EIP-1271 support.

After the two policy-pool registrations and all four custody registrations confirm, the factory activation owner calls `transferOwnership(multisig)`. The multisig then independently verifies bytecode/activation evidence and calls `acceptOwnership()` on:

- `ProtocolModuleFactoryV2`;
- `CvaAssetRegistry`;
- `RiskManagerV2`;
- `SignedValuationOracle`;
- `RepoMarketV2`;
- `MarginEngineV2`.

Record all transfer/acceptance transactions. Confirm `owner()` and `pendingOwner()` on each contract. The one-time deployer and factory activation EOA must have no remaining owner, guardian, registrar-control, signer, keeper, treasury, or service role.

After `RiskManagerV2.configDelay()` has elapsed, compare the complete pending tuple to the approved manifest and have the multisig call `applyConfig(CVA, exactConfig)`. A hash mismatch or early call must revert. Record the `ConfigApplied` hash and decoded tuple.

## Cleanverse custody authorization

Do not use the documentation-mismatched on-chain rule-management functions. Use the supported Cleanverse API/control-plane path and the confirmed runtime `complianceVerify(pool,user)` surface.

Register and record the exact addresses—not implementation names or predicted addresses:

1. `RepoMarketV2` as the isolated-repo compliance policy pool, with its approved rule snapshot.
2. The market `CollateralVaultV2` for the exact CVA through the required A-Pass/CVA custody registration.
3. The market `SettlementEscrowV2` for the exact settlement A-Token.
4. `MarginEngineV2` as a separate policy pool.
5. The margin engine's separate vault for the CVA.
6. The margin engine's separate escrow for the settlement A-Token.

Activation sequence:

1. Configure `PROTOCOL_MODULE_FACTORY_V2_ADDRESS`, both V2 pool addresses, `COMPLIANCE_VALIDATOR_ADDRESS`, and the backend-only `ADMIN_API_KEY`.
2. Call admin-only `/internal/v2/cleanverse/registrar/prepare`. The factory activation owner signs only the returned plaintext using `personal_sign`; never provide its private key.
3. While the deployer is still the live owner of both pools, call `/internal/v2/cleanverse/pools/prepare`, sign each exact returned message, and call `/internal/v2/cleanverse/pools/register` with the approved rule. Wait for each returned transaction hash to confirm.
4. Call `/internal/v2/cleanverse/registrar/grant` with the factory signature and wait for the returned grant transaction to confirm.
5. For the four exact `(pool, A-Token, custody)` bindings, call `/internal/v2/cleanverse/custody/calldata`. It verifies the live factory/validator/module binding and simulates `registerCvaCustody`; the connected factory owner reviews, signs, and submits the returned transaction.
6. Verify all four `CvaCustodyRegistered` events and on-chain receipts, then complete the governance handoff above.

The auctions, factory, oracle, and risk manager do not custody tokens. The factory only performs constrained registrations. For each registration preserve response code, chain transaction hash, address, token, policy-pool address, rules, timestamp, signature-message digest, and operator approval in the manifest. An ordinary wallet A-Pass does not prove contract-custody eligibility.

## Oracle activation

Verify `signerSet()` against the approved three addresses. Produce a fresh EIP-712 valuation for the exact `{asset, settlementToken, priceE18, observedAt, validUntil, nonce, evidenceHash}` payload, obtain signatures from two different authorized signers, and submit it. Confirm:

- the nonce was unused and is scoped to that CVA;
- the evidence object hash matches immutable evidence storage;
- the settlement token matches the market;
- `observedAt` and `validUntil` meet the approved maximum age;
- `latest(CVA)` and the `ValuationAccepted` event match the signed payload.

Never copy a signature across chains, oracle deployments, CVAs, settlement tokens, or nonces.

## Controlled custody smoke and readiness

The readiness flags gate all entry and must remain false until external registration succeeds. Because user deposit paths themselves require readiness, use a controlled two-stage UAT window after registration:

1. Keep both engines entry-paused.
2. Have the multisig set only the target readiness flag (`setAssetVaultReady` or `setCleanverseCustodyReady`) true.
3. Verify the flag and all child `controller`, `asset`, `settlementToken`, `policyPool`, and `isSolvent` reads.
4. Unpause only the target engine without public announcement; execute the smallest end-to-end real-CVA scenario with pre-approved CVI wallets.
5. For the market vault, prove exact deposit and withdrawal, offer reserve/release, one partial fill, and repayment collateral release.
6. Prove the market escrow using an end-to-end path that creates a real pull claim, then withdraw part and the remainder after restoring beneficiary compliance. Never send unaccounted tokens directly to an escrow or vault.
7. Reconcile token balances to `totalAccounted`/`totalClaims` and every projected bucket/claim after finality.
8. Pause entry immediately after the controlled smoke. On any mismatch, leave it paused, set readiness false, preserve evidence, and investigate.
9. Repeat independently for the margin engine, including its separate escrow. Do not infer margin readiness from the market-vault proof.

Only after the smoke report is approved may governance leave isolated-market readiness true and entry unpaused. Cross-margin remains paused and API-disabled until its full matrix passes.

## Service activation

1. Copy only reviewed public addresses and blocks from the final manifest into API/indexer configuration.
2. Set `V2_DEPLOYMENTS_JSON` to the complete source array emitted by the deployment script, including both engines' child vault/auction/escrow addresses. Do not guess deployment blocks.
3. Apply the additive database migration before starting the new indexer.
4. Start the indexer without a keeper first. Wait until every source checkpoint reaches the configured finalized head and compare raw logs to projected offers, positions, balances, auctions, claims, and margin accounts.
5. Start the dedicated gas-limited keeper. It may only execute permissionless lifecycle calls and must hold no owner, guardian, signer, treasury, or custody role.
6. After attaching the exact manifest evidence, set the isolated operator gates `V2_REPO_POLICY_POOL_REGISTERED`, `V2_FEE_TREASURY_AUSDC_ELIGIBLE`, and `V2_SETTLEMENT_ESCROW_AUSDC_READY` true. They default false and must not be inferred from an address.
7. Confirm `GET /v2/config` reports only the registered CVA as `marketReady`, exposes the expected `readiness.operatorAttestations`, `/v2/system/status` is healthy, and transaction-status reads become finalized/indexed after the configured confirmations.
8. Review the emitted `frontendTrustedManifestDraft` against deployed runtime reads and the approved release record. Do not add addresses manually. It must still say `DEPLOYED_NOT_ACTIVE` at this stage.
9. Enable isolated partial fills, early repurchase, vault, and auction API paths.
10. Set `V2_MARGIN_POLICY_POOL_REGISTERED`, `V2_MARGIN_VAULT_CUSTODY_READY`, `V2_MARGIN_ESCROW_AUSDC_READY`, and `V2_MARGIN_TREASURY_AUSDC_ELIGIBLE` true only after their separate evidence is reviewed. Set `V2_MARGIN_ENABLED=true` last, after governance approval, margin indexing, reconciliation, and its full acceptance matrix.
11. Only after all activation proofs pass, change **only** the reviewed draft's `status` from `DEPLOYED_NOT_ACTIVE` to `ACTIVE`, encode it as compact JSON in `VITE_TRUSTED_V2_MANIFEST_JSON`, and create a fresh frontend build. A runtime environment edit cannot safely activate an already-built client.
12. From that exact build, verify API/manifest equality and every pinned runtime code hash before allowing a wallet signature. Preserve the build hash, manifest hash, and result as release evidence.

## V2 acceptance matrix

- A non-CVI wallet is rejected by preflight and contract.
- A disabled, non-issued, wrong-chain, wrong-decimal, or unregistered CVA is rejected.
- A public and a permitted-buyer offer enforce exact access rules.
- Two buyers partially fill one offer; cumulative collateral and fee totals equal a one-shot fill, and the final fill receives only rounding dust.
- Partial cancellation/expiry releases only unfilled collateral; filled positions retain independent acceptance times and maturities.
- Immediate and later early-repayment quotes apply the minimum-hold accrual floor, exact break fee, and scheduled-interest cap.
- Normal, frozen-beneficiary escrow, partial-claim, and restored-compliance claim paths reconcile exactly.
- Grace boundaries match strict on-chain time; default and expiry automation are idempotent under retries.
- A Dutch auction enforces a decreasing live price, caller max-price protection, complete buyer payment, CVA delivery, lender/fee/seller waterfall, and shortfall reporting.
- An unsold auction produces the correct lender collateral path; stale-oracle fallback cannot bypass its delay or lender authorization.
- Entry pause blocks new exposure but not cancel, withdraw, repay, auction, escrow claim, or lender recovery.
- Cross-margin proves seller-authored target/minimum/rate/duration/expiry/permitted-lender constraints, permanent funding closure, account isolation, fixed face debt, aggregate health, margin call/cure, payment cross-default, successful and failed liquidation, permissionless pro-rata claim materialization, zero-rounded claim progress, final-claim dust, and close only at zero liabilities.
- Kill the keeper immediately before and immediately after first broadcast; restart it and prove the durable `SUBMITTED` signed envelope rebroadcasts only identical bytes/hash/nonce and becomes successful only after configured finality.
- Force browser receipt timeout and indexer delay; reload and prove the persisted transaction hash prevents duplicate signing until chain and finalized projection agree.
- Vault assets equal liabilities and escrow assets equal outstanding claims after every path.
- API quote/transfer graph, wallet receipt, confirmed raw log, PostgreSQL projection, and UI status agree.

## Monitoring and reconciliation

Alert on stalled checkpoints, reorg replay, dead automation jobs, repeated preflight denial spikes, RPC/Cleanverse latency, stale oracle age, oracle signer disagreement, vault insolvency, escrow balance below claims, auction expiry backlog, margin-call backlog, ownership/guardian changes, risk changes, and readiness/feature-flag drift.

Run a periodic independent reconciliation from chain state, not the API cache. Keep correlation IDs, transaction hashes, decoded events, Cleanverse decision snapshots, and release-manifest hashes in the audit trail.

## Incident and rollback actions

- **Cleanverse/RPC outage:** API fails closed. Pause entry if impact is sustained; never bypass preflight or token hooks.
- **Key compromise:** guardian pauses entry, operations removes the affected key from services, governance rotates it through the documented delayed path, and evidence is preserved. Do not pause exit/recovery paths.
- **Oracle fault:** stop new valuations, pause entry, invalidate the affected digest if governance confirms compromise, and preserve lender stale-oracle recovery timing.
- **Indexer divergence:** stop indexer/keeper, snapshot PostgreSQL, use a reviewed additive/replay migration, and replay every configured source from its recorded deployment block.
- **Accounting mismatch:** pause both engines, set the affected readiness flag false, stop automation if it could worsen the mismatch, reconcile raw token balances/events, and do not use rescue functions against accounted assets.
- **Failed settlement:** save correlation ID and transaction hash; compare the quote block, live Cleanverse state, allowance/balance, revert data, receipt, and indexed event.
- **V2 rollback:** disable API/UI feature flags and keep entry paused. Contracts are immutable and existing positions remain closeable; never redeploy over addresses or rewrite their history. Continue V1 close-only operation where applicable.
