# RWCAR Cleanverse CVA / A-Token Context

Last updated: 2026-08-05 (Asia/Dhaka)

This is the persistent CVA integration record for future RWCAR sessions. Read this file before changing the Cleanverse or Monad integration.

## Non-negotiable project rule

- RWCAR must not use mocked identities, mocked assets, mocked compliance decisions, mocked balances, or simulated blockchain transactions.
- The hackathon build uses the real Cleanverse UAT API and real contracts on Monad Testnet.
- Do not display a token as verified merely because it appears in local UI data.
- Never place the Cleanverse `api-key` or Privy app secret in React/Vite code or a `VITE_*` variable.
- Never commit credentials, wallet private keys, seed phrases, identity documents, or raw KYC data.

## Authoritative local source

- Full API document: `/storage/emulated/0/Download/ghn.pdf`
- Document title/version: Cleanverse API V5.6
- Length: 139 pages
- A-Pass fragment: `/storage/emulated/0/Download/ghk.pdf`
- A-Pass fragment length: 43 pages; ends at the beginning of A-Token Management
- Validator fragment: `/storage/emulated/0/Download/nnn.pdf`
- Validator fragment length: 142 pages; contains the complete Validator Compliance chapter and ends at the start of Fiat Ramp
- Secondary/incomplete export: `/storage/emulated/0/Download/cleanverse.pdf`
- The V5.6 PDF is authoritative when the two files differ.

The V5.6 PDF contains detailed A-Token issuance, registration, status, rules, pause, webhook, and institutional wrapped-token whitelist documentation. Its overview mentions Common Query and Validator modules, but the copy inspected does not contain complete endpoint chapters for all Common Query/Validator operations. Do not invent missing request schemas.

## Environment and authentication

- Sandbox base URL: `https://uatapi.cleanverse.com/api/cooperate`
- Production base URL: `https://api.cleanverse.com/api/cooperate`
- Every request requires the `api-id` header.
- `api-id` identifies the institution/application; it is not the encryption key.
- The Base64-encoded `api-key` is used locally for encryption and webhook verification. It must never be sent as a header or returned to the browser.
- Use a unique UUID in optional `X-Request-ID` for traceability.
- The sandbox credentials exist, but their values are intentionally not recorded here. Load them from backend-only environment variables.
- Credentials previously pasted into chat must be rotated before final deployment.

### Encryption

Endpoints marked encrypted accept exactly:

```json
{ "data": "<Base64 ciphertext>" }
```

Encryption specification:

- Algorithm: AES
- Mode/padding: AES/CBC/PKCS5Padding (PKCS7 equivalent for AES block size)
- IV: 16 zero bytes
- Key bytes: Base64-decode the Cleanverse `api-key`
- Plaintext: UTF-8 JSON string
- Output: Base64-encoded ciphertext

Do encryption only in the RWCAR backend.

### General response behavior

- Cleanverse commonly returns HTTP 200 with an application-level `code`.
- `0000`: success.
- `0001`: invalid parameter.
- `0002`: business failure.
- Do not treat HTTP 200 by itself as success.
- Handle `data` defensively: depending on the endpoint/error it may be an object, `null`, or the string `"{}"`.

## What a CVA is in RWCAR

Cleanverse calls the verified/compliant token an **A-Token**. RWCAR uses **CVA** as the product-facing term for a Cleanverse Verified Asset.

An asset is eligible for RWCAR only when all relevant checks agree:

1. The exact chain and contract address came from a Cleanverse institution/supported-token response.
2. The application state is `ISSUED`; no other application status counts as success.
3. The A-Token is not paused.
4. Its compliance rules are readable.
5. The current sending and receiving wallets pass Cleanverse A-Pass/A-Token verification.
6. The contract has bytecode on the configured Monad network.
7. On-chain ERC-20 metadata, decimals, balance, allowance, and transfer behavior are checked.
8. The transaction itself succeeds on-chain.

`ISSUED` proves Cleanverse UAT issuance on the test network. It must not be presented as proof of a production legal claim, valuation, or guaranteed redemption unless separate issuer/legal evidence is available.

## CVI / A-Pass details confirmed from `ghk.pdf`

The file documents A-Pass generation and freeze/unfreeze writes. It does **not** contain the full `/query_apass`, `/query_apass_list`, or `/verify_apass` endpoint sections.

### Generate an A-Pass

- Endpoint: `POST /generate_apass`
- Authorized roles shown: Issue Member and Gateway Member
- Body: AES-encrypted using the common Cleanverse encryption format
- Required top-level fields: `customerId`, `expirationTime`, `wallet`
- Optional top-level fields: `kycSource`, `kycId`, `subTier`, `subGroup`, `override`, `identityDataList`, `bankAccountList`
- `customerId`: unique, at least 12 characters, only `A-Z`, `a-z`, and `0-9`; no spaces or punctuation
- `expirationTime`: Unix timestamp in seconds
- `subTier`: 1-99 when supplied
- `subGroup`: exactly two case-sensitive letters when supplied
- `override`: defaults to `false`
- `wallet.address`: required public wallet address
- `wallet.chain`: required and case-insensitive; supported values include `monad`

Identity document item fields:

- `idType`: one of `ID_CARD`, `PASSPORT`, `DRIVER_LICENSE`, `HK_MACAO_TAIWAN_PASS`, `RESIDENCE_PERMIT`
- `fullName`: required
- `idNumber`: optional raw number or SHA-256 hash in hexadecimal form
- `validUntil`: optional `yyyy-MM-dd`
- `issuingCountryISO2`: required ISO 3166-1 alpha-2 code

Cleanverse normalizes and deduplicates `issuingCountryISO2` values into uppercase A-Pass country tags. Those tags are later returned by the A-Pass query endpoints and evaluated by CVA rules.

Bank-account item fields:

- `bankCountry`: required ISO 3166-1 alpha-2 code
- `bankName`: required
- `bankAccount`: optional
- `bankAccountType`: optional; `C` credit, `D` debit, `A` bank account
- `balance`: optional integer/long
- `currency`: optional ISO 4217 currency code

RWCAR must not collect raw identity documents or bank details merely to demonstrate the repo flow. A real KYC provider/member onboarding route should create the A-Pass server-to-server. Prefer a hashed `idNumber` when Cleanverse accepts it. Never log the decrypted body.

Successful generation returns `customerId`, `cvRecordId`, `tier`, and a `wallet` object containing the public address, chain, operation, on-chain transaction hash, and deposit-related fields. On EVM chains, the documented USDC and USDT deposit-wallet fields share the same semantics. Solana-only account/PDA fields should not be expected on Monad.

Special response code `1000` warns that an existing A-Pass group will be affected by an update. The documentation says to retry with `override: true` only when the caller intentionally accepts that consequence. RWCAR must never retry this automatically.

### Freeze or unfreeze an A-Pass

- Endpoint: `POST /update_status`
- Authorized roles shown: Issue Member and Gateway Member
- Body: AES-encrypted
- Required: `status`, `wallet.chain`, `wallet.address`
- Optional identifiers: `customerId`, `cvRecordId`
- Optional `blacklistReason`, normally used when freezing
- `status: "1"`: activate/unfreeze
- `status: "2"`: freeze
- Successful response includes the on-chain `txHash`

RWCAR's normal trading path is read-only for identity status. It must not freeze or unfreeze users. Status mutation belongs to the authorized Cleanverse/KYC administration workflow.

## Monad configuration

- Network: Monad Testnet
- Cleanverse chain value: `monad`
- Chain ID: `10143`
- Native gas token: MON
- RPC tested: `https://testnet-rpc.monad.xyz`
- Explorer: `https://testnet.monadscan.com`

All RWCAR asset and balance checks must use chain ID `10143`. A contract with the same address on another chain does not count.

## Verified UAT participants

### Buyer

- Wallet: `0xF7100Bcc9B352f18b80018D7708177C3C04a128D`
- Customer ID: `RWCAR20260805BUYER01`
- CV record ID: `957`
- Status: `1` (active)
- Tier: `50`
- Country tag: `BD`
- Expiration: `1817510399`
- A-Pass transaction: `0xfdad61b04af691bf4cd7f3e3fb43c97cda3ab676ef49262a1ff50ee08fdb4f4a`
- RWRN01 `/verify_apass`: code `4`
- aUSDC `/verify_apass`: code `4`
- Funding after setup: `5 MON`, `0.02 aUSDC`
- aUSDC faucet transaction: `0x6e9c566a0bcc9059ff46fd349ae7bd87358ee1fc5ac00c6a547376f7e3e9e979`
- Second aUSDC faucet transaction: `0x57834055a216d2affdae3ab6b48aeb83f6b4c78e97572e887fa6fea0feea45d2`

The A-Pass was generated through the real Cleanverse UAT API using the synthetic-KYC shortcut explicitly approved by Cleanverse for hackathon integrations. It is real UAT/on-chain compliance state, not production identity verification.

### Buyer 2

- Wallet: `0x41499fc5E8058Ac2028eBc53326Fa7cA624b9cfa`
- Customer ID: `RWCAR20260806BUYER02`
- CV record ID: `1005`
- Status: `1` (active)
- Tier: `50`
- Sub-tier: `0`
- Country tag: `BD`
- Expiration: `1817596799` (2027-08-06 23:59:59 UTC)
- A-Pass transaction: `0x358f82e362464f21b94bd0fb219aa2f1f72f2bf811d7ad091b85523db4d6df2c`
- A-Pass transaction status: successful at Monad block `51328824`
- RWRN01 `/verify_apass`: code `4`
- aUSDC `/verify_apass`: code `4`
- Direct RepoMarket pool `complianceVerify`: `true`
- Funding snapshot after setup: `5 MON`, `0 aUSDC`, `0 RWRN01`

This A-Pass also uses synthetic hackathon UAT identity data approved for rapid integration. It is valid Cleanverse UAT/on-chain compliance state, not production KYC.

## RWCAR-issued UAT CVA for the repo collateral leg

### RWCAR Receivable Note I

- Name: `RWCAR Receivable Note I`
- Symbol: `RWRN01`
- Contract: `0x7A33e03B10268FFdB50e562721B092BC0Cb793F9`
- Chain: Monad Testnet
- Decimals: 6
- Admin: `0x911F99f424D47F08a15fcC771e94dcc2f7252B02`
- Launch request: `IA20260805120745190158`
- Cleanverse application status: `ISSUED`
- Issuance transaction: `0xeb0adb893e98171fef8f67d118e8da3b0816dad03f7a1d016116273dbf13c785`
- Issued at: `2026-08-05 12:07:45`
- RuleV2: minimum CVI tier 30, no group/sub-group restriction, and no country restriction
- Admin wallet `/verify_apass` result: code `4` (success)
- Admin wallet has `DEFAULT_ADMIN_ROLE` and `MINTER_ROLE` on-chain.
- `MINTER_ROLE` grant transaction: `0x4a4dc60449cbc0943bd3a93c0c84c4e47ff09b2eb6aaa0b50d8700c98005efe9`
- Mint transaction: `0xe2e9260d914089bb3571b09980ea0acaf5fc89a74981b6717d596f299ca05bbe`
- Minted/admin balance: `100 RWRN01` (`100000000` base units)
- Total supply after mint: `100 RWRN01`
- Cleanverse paused state after mint: `false`

Issuer operations are separated from the public trading frontend. The current user application contains no mint/admin controls and never accepts an issuer private key.

## Previously evaluated UAT collateral candidate

### Clearwave Royalty Share III

- Name: `Clearwave Royalty Share III`
- Symbol: `CWRS03`
- Contract: `0x0EDd0C78Ec0538ffC5486FD51364EA69c4d82f36`
- Chain: Monad Testnet
- Decimals: 6
- Cleanverse application status at last check: `ISSUED`
- Cleanverse paused state at last check: `false`
- On-chain total supply at last check: `15` tokens
- Issuance transaction: `0xf175c3a6e9bd4c67d3fef73e9fc18b1c3f3f4d275aa2fd11efcf1018d0248699`
- Issuance block: `48952038`

Rules returned by `POST /atoken/rules` at last check:

```json
{
  "allowed_group": "",
  "allowed_sub_group": "",
  "min_tier": 0,
  "min_sub_tier": 0,
  "is_black_list": false,
  "countries": []
}
```

Important: the PDF describes tier checks as being greater than the configured minimum. Do not infer wallet eligibility from the rule locally. The Cleanverse verification endpoint and the on-chain transfer result are the source of truth.

The current holder of the 15 CWRS03 tokens had not been identified when this file was created. Monad's public RPC restricted `eth_getLogs` queries to 100-block ranges, so a full brute-force holder scan was not completed. For the demo, query the connected seller's balance first and obtain a legitimate transfer from the current holder/issuer if it is zero.

## Selected real UAT settlement token

`POST /query_deposit_atoken_list` with `{"chain":"monad"}` returned one supported wrapped-token pair at the last check:

### Origin USDC

- Address: `0x534b2f3A21130d7a60830c2Df862319e593943A3`
- Symbol: `USDC`
- Decimals: 6

### Cleanverse wrapped A-Token

- Name observed on-chain: `Access USDC`
- Symbol: `aUSDC`
- Address: `0xaC0893567D43C3E7e6e35a72803df05416C1f20D`
- Decimals: 6
- `accesscore_address`: `0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC`
- `apass_address`: `0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9`
- On-chain total supply at last check: `112.14` aUSDC

Use aUSDC for the repo purchase and repurchase payments. Origin USDC and aUSDC are different contracts and must never be confused in approvals, balances, or UI labels.

## Other issued Monad A-Token candidates observed

These came from the institution's live `GET /atoken/list_my_atokens` response with `chain=monad&apply_status=ISSUED`. Supply is the last observed on-chain value and can change.

| Name | Symbol | Address | Decimals | Last supply |
|---|---|---|---:|---:|
| AA_FalconXUSDC Vault Tokens | AAFAL | `0x8EdCE92B31494b3ea5DE8caE376b22900C19f44e` | 6 | 0 |
| muBOND | MUBOND | `0xf0973BA19952236feAfbDc5291fE08f751354254` | 6 | 0 |
| CircuitLend Device Note T1 | CLDT01 | `0x4727a40d36cDa8505c42caFaAD262BCF22ABaEEb` | 6 | 0 |
| Talon Bond 2026 | TLNB | `0xbAE642890988C3EF56e77Fb041aFD847A6131d64` | 6 | 0.064505 |
| Coven CVN-2026-0042 | CVN | `0x68d4b25B38F2549fd678A05f71821027f0592Bf2` | 6 | 0 |
| Clearwave Royalty Share III | CWRS03 | `0x0EDd0C78Ec0538ffC5486FD51364EA69c4d82f36` | 6 | 15 |
| Clearwave Royalty Share II | CWRS02 | `0x45fFB672188008CA942E08c85d93d460948Ebdec` | 6 | 10 |
| Mordant Invoice Note | MINV01 | `0x66F706D1Dc820CF09EBA5359cE9acd0D290bC17b` | 6 | 0 |
| Clearwave Royalty Share | CWRS01 | `0x56bc7D32d09E52E8091edE433DbAAb554401AcE6` | 6 | 10 |

Assets explicitly named or described as mock/test must be excluded. A name that looks realistic is not sufficient by itself; apply the full verification pipeline.

## A-Token issuance and registration

These are institution/Issue Member operations, not ordinary RWCAR trader operations.

### Launch a standard A-Token

- Endpoint: `POST /atoken/launch`
- Body: encrypted
- Required plaintext fields: `chain`, `token_name`, `token_symbol`, `decimals`, `admin_address`, `rule`, `icon`
- Optional: `callback_url`
- Initial response contains `requestId` and `issueAssetId`.
- After `ISSUED`, the configured admin must grant `MINTER_ROLE` to the token minter before minting to users.

### Register an existing standard A-Token

- Endpoint: `POST /atoken/register_atoken`
- Body: encrypted
- Fields: `chain`, `atoken_address`, `owner_signature`, `atoken_icon`, optional `callback_url`
- The owner signs the string formed by lowercase `chain` concatenated with `atoken_address` using EIP-191 `personal_sign`.
- Cleanverse verifies this signature before forwarding the application.
- Initial response contains `requestId` and `issueAssetRegisterId`.

### Launch a Wrapped A-Token

- Endpoint: `POST /atoken/launch_wrapped_atoken`
- Body: encrypted
- Required fields: `chain`, wrapped token name/symbol/decimals, `admin_address`, `rule`, `origin_token_address`, `origin_token_icon`, `icon`
- Optional: `callback_url`
- After `ISSUED`, admin grants `MINTER_ROLE` to the `access_core` contract returned by the supported-token query.
- For whitelisted institution deposit senders, `access_core` locks origin tokens and mints wrapped A-Tokens 1:1.

### Register a Wrapped A-Token

- Endpoint: `POST /atoken/register_wrapped_atoken`
- Body: encrypted
- Fields: `chain`, `atoken_address`, `atoken_icon`, `origin_token_address`, `origin_token_icon`, `owner_signature`, optional `callback_url`
- Owner-signature payload follows the same lowercase-chain-plus-A-Token-address EIP-191 rule.

### Application status

- Endpoint: `GET /atoken/query_apply_status/{requestId}`
- `api-id` required; request body not used.
- The application is asynchronous.
- Possible states include `PENDING`, `APPROVED`, `ISSUING`, `ISSUED`, `REJECTED`, and `ISSUE_FAILED`.
- **Only `ISSUED` is success.**
- `REJECTED` and `ISSUE_FAILED` are terminal failures.
- Response can include `flowType`, `requestId`, `applyStatus`, rejection/failure reason, `chain`, `atokenAddress`, `originTokenAddress`, `tokenSymbol`, issuance transaction hash/time, and webhook delivery fields.
- An institution can query only its own application. Unknown/out-of-scope requests can return code `12015`.

### List institution A-Tokens

- Endpoint: `GET /atoken/list_my_atokens`
- Query parameters: `page`, `page_size` (maximum 100), optional `chain`, optional `apply_status`, optional `flow_type`
- Flow types: `LAUNCH`, `LAUNCH_WRAPPED`, `REGISTER_ATOKEN`, `REGISTER_WRAPPED`
- This list is the discovery source for institution-issued tokens; recheck individual state and on-chain facts before trading.

## Compliance rule model

Rule fields:

- `allowed_group`: empty or exactly two case-sensitive characters.
- `allowed_sub_group`: empty or exactly two case-sensitive characters.
- `min_tier`: integer 0-99.
- `min_sub_tier`: integer 0-99.
- `is_black_list`: when `true`, listed countries are denied; when `false`/omitted, listed countries form a whitelist.
- `countries`: ISO 3166-1 alpha-2 codes. Cleanverse uppercases valid values; empty/omitted means no country constraint.

Cleanverse evaluates these rules with A-Pass tier, subTier, group, subGroup, and country tags to decide whether a wallet may receive or transfer the A-Token.

Relevant endpoints:

- `POST /atoken/rules`: plain JSON read with `chain` and `atoken_address`.
- `POST /atoken/add_rule`: encrypted write; create-only and rejects an identical duplicate.
- `POST /atoken/remove_rule`: encrypted write with `chain`, `atoken_address`, and returned rule `index`.
- `POST /atoken/is_paused`: plain JSON read with `chain` and `atoken_address`.
- `POST /atoken/set_paused`: encrypted write with `chain`, `atoken_address`, and `paused`.

RWCAR reads rules and pause state. It should not mutate issuer rules or pause state as part of normal repo trading.

## A-Token application webhook

- Optional `callback_url` can be included in launch/register requests.
- Terminal events: `ISSUED`, `REJECTED`, `ISSUE_FAILED`.
- Event header: `X-Cleanverse-Event: ATOKEN_APPLY_RESULT`.
- `X-Cleanverse-Delivery-Id` is a unique UUID and must be used for idempotency.
- Verify `X-Cleanverse-Signature` as lowercase hex HMAC-SHA256 of the exact raw request-body bytes using `Base64.decode(api-key)` as the key.
- Do not parse and reserialize before signature verification.
- Return HTTP 2xx quickly and process asynchronously.
- Retry delays on failure: 1, 5, 15, 60, and 240 minutes, up to five attempts total.

## Wrapped-token institutional deposit whitelist

These endpoints apply only to wrapped A-Tokens issued by the institution:

- `POST /atoken/add_whitelist_for_institutional`
- `POST /atoken/remove_whitelist_for_institutional`
- `POST /atoken/restore_whitelist_for_institutional`

All three use encrypted bodies.

The add request includes institution metadata and per-chain entries containing origin-token `symbol`, origin `assetAddress`, and permitted sender `walletAddresses`. A whitelisted origin-token transfer to a Cleanverse deposit address can trigger 1:1 wrapped A-Token credit. A non-whitelisted sender does not receive the wrapped token; the origin token is forwarded to the wallet associated with the deposit address.

Duplicate whitelist rows are keyed by chain + symbol + asset address + wallet address and can return `12029`. Remove is a soft deactivation (`is_active: 0`); restore reactivates it (`is_active: 1`). Both are idempotent for already-removed/already-active rows.

Do not assume the generic `/faucet` endpoint can mint CWRS03. Funding support and exact Monad symbols must be verified from a real response before presenting a faucet action.

## RWCAR CVA verification pipeline

For each repo action, the backend/UI must distinguish these checks:

1. **Discovery:** load institution/supported Monad A-Tokens from Cleanverse.
2. **Issuance:** require `applyStatus === "ISSUED"`.
3. **Pause:** require `paused === false`.
4. **Rules:** retrieve and display current rule summary.
5. **Identity:** query each participant's A-Pass/CVI.
6. **Transfer eligibility:** call Cleanverse A-Pass/A-Token verification for the exact wallet and A-Token; code `4` was documented in the supplied project notes as success. Confirm the precise V5.6 request schema before implementation because the inspected V5.6 PDF copy lacks the complete Common Query chapter.
7. **Network:** require Monad Testnet chain ID 10143.
8. **Contract:** require bytecode at the expected address.
9. **Token state:** read ERC-20 name, symbol, decimals, balance, allowance, and supply.
10. **Preflight:** simulate/estimate the intended transfer or RepoMarket call.
11. **Execution:** require a successful on-chain receipt.
12. **Audit:** persist request IDs, verification timestamp/result, transaction hash, block, and final repo status without storing unnecessary PII.

Repeat time-sensitive checks immediately before offer acceptance and settlement. Cached eligibility must have a short TTL and must never override an on-chain revert.

## Validator Compliance confirmed from `nnn.pdf`

The Validator module manages Cleanverse compliance rules for a registered on-chain pool/contract. For RWCAR, the deployed RepoMarket contract is the intended pool candidate. This adds protocol-level participant eligibility alongside the separate A-Token transfer restrictions.

Do not conflate the two layers:

- **CVA/A-Token rules** determine whether a wallet can receive or transfer the selected asset.
- **Validator pool rules** determine whether a wallet satisfies the RWCAR RepoMarket pool's A-Pass policy.

Both seller and buyer should pass both applicable layers.

### Terminology and request security

- Pool/registered contract: the on-chain address passed as `contract_address`.
- Registrar role: `REGISTER_ROLE`, which allows new pools to be registered.
- Pool rule: A-Pass group/subgroup/tier/sub-tier and optional country allow/deny restrictions.
- Encrypted writes: `/validator/grant`, `/validator/register`, `/validator/set_rule`, `/validator/add_rule`, `/validator/remove_rule`, `/validator/set_paused`.
- Plain JSON reads: `/validator/is_register`, `/validator/rules`, `/validator/verify`, `/validator/is_paused`.
- Write operations return `tx_hash`; wait for chain confirmation before a dependent mutation.
- Validator write failure may return code `12026`.
- Validator read/on-chain verification failure may return code `12027`.

### Owner signature requirement

`/validator/grant` and `/validator/register` require an EIP-191 `personal_sign` signature.

Signed message format:

```text
lowercase(chain) + lowercase(subject address)
```

There is no separator. For `grant`, the subject is the request `address`; for `register`, it is `contract_address`. Cleanverse verifies that the signer is the value returned by the subject contract's on-chain `owner()`.

Therefore, the RWCAR RepoMarket contract intended for registration must expose a compatible `owner()` function (for example, standard Ownable behavior), and its actual owner must sign the registration message. Never ask the owner to share a private key.

### Grant registrar role

- Endpoint: `POST /validator/grant`
- Encrypted fields: `chain`, `address`, `owner_signature`
- The address receives `REGISTER_ROLE` on success.
- The docs say this signed grant is intended for smart contracts exposing `Ownable.owner()`.

### Register the RepoMarket compliance pool

- Endpoint: `POST /validator/register`
- Encrypted fields: `chain`, `contract_address`, initial `rule`, `owner_signature`
- Response includes normalized chain/address and `tx_hash`.
- Registration status read: `POST /validator/is_register` with plain `chain` and `contract_address`; require `registered: true`.

The exact grant/register transaction sequence for the final RepoMarket must be confirmed in UAT after deployment. Do not label the market Cleanverse-registered before `is_register` returns `registered: true`.

### Validator pool rule object

- `allowed_group`: empty means no restriction; otherwise 1-2 characters.
- `allowed_sub_group`: empty means no restriction.
- `min_tier`: 0-99; the Validator chapter explicitly says `0` means no restriction.
- `min_sub_tier`: 0-99; `0` means no restriction.
- `is_black_list`: optional; `true` denies listed A-Pass countries, `false`/omitted treats listed countries as allowed.
- `countries`: optional ISO 3166-1 alpha-2 values; empty/omitted means no country restriction; values may be normalized to uppercase.

Pool rule endpoints:

- `POST /validator/set_rule`: encrypted; replaces all rules with one rule.
- `POST /validator/add_rule`: encrypted; appends a rule.
- `POST /validator/remove_rule`: encrypted; removes a zero-based rule index.
- `POST /validator/rules`: plain JSON; returns all current rules.

Wait for each rule mutation transaction to confirm before making another mutation on the same pool.

### Verify a participant against RepoMarket rules

- Endpoint: `POST /validator/verify`
- Plain JSON fields: `chain`, `contract_address`, `user_address`
- A successful request returns application `code: "0000"` and `data.valid`.
- `valid: true`: wallet satisfies the registered pool's rules.
- `valid: false`: the verification call succeeded but the wallet is not eligible. This is a compliance denial, not an API error.
- If the pool is paused, verification may return `12027` instead of `valid`.

RWCAR must require `code === "0000" && data.valid === true` for both seller and buyer immediately before the relevant repo transaction.

### Pause state

- `POST /validator/set_paused`: encrypted fields `chain`, `contract_address`, `paused`.
- `POST /validator/is_paused`: plain fields `chain`, `contract_address`.
- A paused RepoMarket pool cannot be treated as tradable; disable create/accept/settle actions until unpaused and reverified.

### Enforcement gap still requiring the starter contract/ABI

Registering a pool and calling `/validator/verify` provides a real Cleanverse compliance decision, but the PDF fragment does not show how the RepoMarket Solidity code calls the Validator contract on-chain. Without the Validator address and ABI/interface, a user could potentially bypass a frontend/backend precheck by calling RepoMarket directly.

Before production-quality deployment, obtain the Cleanverse Validator contract address plus Solidity interface/sample and enforce eligibility inside the RepoMarket transaction path. Until that is confirmed, describe `/validator/verify` as a real pre-trade compliance check, not as proven on-chain function-level enforcement.

## Team-provided CCP and Common Query details (2026-08-04)

These details were relayed as answers from the Cleanverse team/official CCP material. Items independently checked against Monad RPC are labelled accordingly. Exact ABIs must still be reconciled with the deployed implementation before compilation/deployment.

### A-Pass reads

`POST /query_apass` plain request:

```json
{
  "chain": "monad",
  "address": "0x..."
}
```

Reported response fields include tier, subTier, status (`1` active, `2` frozen), group, subGroup, countries, `expirationTime`, and `currentKycHash`.

`POST /query_apass_list` reported request (all filters optional):

```json
{
  "page": 1,
  "pageSize": 20,
  "chain": "monad",
  "walletAddress": "0x...",
  "status": 1
}
```

RWCAR's normal user path should use the single-wallet query. The list endpoint is administrative and is not required to execute a bilateral repo.

### A-Pass plus A-Token verification

`POST /verify_apass` plain request:

```json
{
  "chain": "monad",
  "atoken": "0x...",
  "address": "0x..."
}
```

Reported `data.code` meanings:

- `1`: A-Token not found.
- `2`: user does not have an A-Pass.
- `3`: A-Pass exists but transfer is unavailable because it is expired or frozen.
- `4`: valid A-Pass and A-Token transfer is allowed.

RWCAR requires result `4` for the exact asset and wallet. Keep the outer Cleanverse application code separate from `data.code`; both layers must be parsed and logged correctly.

### Other reported Common Query paths

- `POST /query_deposit_atoken_list`: supported origin-token/A-Token pairs.
- `POST /query_deposit_address`: Cleanverse USDC/USDT deposit address resolution.
- `POST /query_txs`: indexed transaction history.
- `POST /faucet`: UAT token funding.

Reported Monad faucet request:

```json
{
  "chain": "monad",
  "symbol": "ausdc",
  "depositAddress": "0x...",
  "amount": "1"
}
```

Reported supported examples include `ausdc`, `usdc`, `ausdt`, and `usdt`, subject to rate limiting. This does not establish that `/faucet` can provide CWRS03 or another non-stablecoin CVA. Do not call the faucet until the user supplies the intended public recipient address and authorizes the funding action.

Cleanverse later confirmed that the official faucet documentation explicitly lists only `usdc`, `ausdc`, `usdt`, and `ausdt`. On 2026-08-04, a live UAT request for symbol `CWRS03`, amount `1`, and the user-provided Monad wallet progressed to an attempted token transfer, then reverted with the A-Token custom error `NoAPass` for the recipient. A following `/query_apass` returned A-Pass not found, and `/verify_apass` returned outer success with `data.code: 2` (no A-Pass). This is strong evidence that the faucet resolves/supports CWRS03, but funding cannot complete until the recipient has a valid A-Pass. Retry after real CVI onboarding; retain the issuer/current-holder transfer route if a later faucet policy/rate-limit error occurs.

### Monad A-Pass Compliance Validator

Reported proxy address (same address used across supported EVM test networks):

```text
0xaC7e5179C2C7f03f209136886c172eb34F161792
```

Independent Monad Testnet RPC verification on 2026-08-04 confirmed:

- The address has deployed bytecode.
- It is an EIP-1967 proxy.
- Its current implementation slot resolved to `0x68ce853d660444ffd98d6d5d98ac8ad58241d5a9`.
- The implementation has deployed bytecode.
- The deployed implementation contains selectors for `complianceVerify(address,address)`, both reported `registerApass` overloads, `removeRuleV2FromContract(uint256)`, `getRulesV2(address)`, and `isRegistered(address)`.

Reported interface:

```solidity
interface IAPassComplianceValidator {
    struct RuleV2 {
        bytes2 allowedGroup;
        bytes2 allowedSubGroup;
        uint8 minTier;
        uint8 minSubTier;
        uint256 poolCountryBitmap;
    }

    function complianceVerify(address poolAddress, address userAddress)
        external view returns (bool);

    function registerV2(address poolAddress, RuleV2 calldata rule) external;
    function registerApass(address poolAddress, address aTokenAddress) external;
    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external;
    function setRuleV2FromContract(RuleV2 calldata rule) external;
    function addRuleV2FromContract(RuleV2 calldata rule) external;
    function removeRuleV2FromContract(uint256 index) external;
    function getRulesV2(address poolAddress) external view returns (RuleV2[] memory);
    function isRegistered(address poolAddress) external view returns (bool);
}
```

ABI caution: selector inspection did **not** find exact matches for the three signatures `registerV2(address,(bytes2,bytes2,uint8,uint8,uint256))`, `setRuleV2FromContract((bytes2,bytes2,uint8,uint8,uint256))`, and `addRuleV2FromContract((bytes2,bytes2,uint8,uint8,uint256))` in the current Monad implementation bytecode. Cleanverse subsequently confirmed this is a known mismatch between the CCP Guide and the live contract. It is non-blocking for RWCAR. Do not include the mismatched rule-management functions in the RepoMarket interface. Configure rules through the encrypted backend calls to `POST /validator/set_rule` and `POST /validator/add_rule`. The RepoMarket runtime interface should contain only the confirmed `complianceVerify(address,address)` function.

### Required RepoMarket runtime enforcement

Reported CCP integration pattern:

```solidity
require(
    validator.complianceVerify(address(this), user),
    "A-Pass not qualified"
);
```

Apply the gate inside every externally reachable sensitive RepoMarket path, not only in the React/backend flow. At minimum:

- Offer creation: verify seller.
- Offer acceptance/opening DvP: reverify seller and verify buyer.
- Repurchase/closing DvP: reverify seller and buyer.
- Any participant-changing or asset-moving administrative path: verify affected participants or restrict it to a documented compliance resolution process.

The pool must first be registered through the Cleanverse Validator process, and the app must confirm registration on-chain/API before enabling trading.

### A-Token `transferFrom` operator behavior

The team-provided answer says the calling contract/operator does not need a separate A-Pass. The A-Token's internal transfer hook checks the `from` and `to` addresses and reverts if either fails compliance.

This supports the direct atomic DvP design: RepoMarket can call `transferFrom` while the actual seller and buyer remain the checked token holders. Perform a small live UAT transfer through the deployed RepoMarket before relying on this behavior for the demo.

Compliance consequence: if either participant becomes frozen or ineligible before repurchase, the CVA return can revert. RWCAR must show the position as compliance-blocked and must not transfer repayment separately. A documented Cleanverse/issuer resolution path is needed for such exceptional cases.

## RWCAR repo transfer design

Preferred compliance-aware structure:

```text
Opening (one atomic transaction)
Seller -> Buyer: CVA collateral token
Buyer  -> Seller: aUSDC principal

Repurchase (one atomic transaction)
Seller -> Buyer: aUSDC principal + repo interest
Buyer  -> Seller: original CVA quantity
```

The RepoMarket contract coordinates `transferFrom` calls and records the obligation but does not permanently custody the CVA. This avoids assuming an unidentified escrow contract can itself satisfy A-Pass holder restrictions.

Before deployment, perform a live transfer/preflight test to determine whether the A-Token compliance contract checks only `from`/`to` or also the RepoMarket operator. If it checks the operator, obtain the required Cleanverse authorization rather than bypassing the rule.

If the seller misses the repurchase deadline/grace period, the buyer already owns and keeps the CVA, and the repo is marked defaulted. Closing must remain atomic so repayment cannot leave the seller without receiving the CVA back.

## Data still required for the end-to-end demo

- Fresh public UAT deployer, separate pending owner, and compliant fee-treasury addresses. The deployer needs test MON; private keys stay only in the user's deployment shell.
- Neon `DATABASE_URL`, Railway service configuration, and an S3-compatible private evidence bucket if document upload is demonstrated.
- Cleanverse registration of the deployed RepoMarket as a compliance pool, with the owner-generated signature and approved RuleV2.
- Signed valuation snapshot for RWRN01 and its evidence hash.
- Confirmation through a small live RepoMarket trade that RWRN01 permits the operator-mediated seller-to-buyer and buyer-to-seller `transferFrom` paths.
- Re-query both known CVI wallets, RWRN01/aUSDC balances, allowances, pause state, rules, and application status immediately before recording.

Never request wallet private keys or seed phrases to satisfy these requirements.

## Snapshot warning

Addresses are stable identifiers, but application state, rules, pause state, balances, allowances, supply, holders, API responses, and RPC endpoints can change. Re-query Cleanverse and Monad before every demo/deployment and update this document with the verification timestamp.

## RWCAR UAT contract deployment (2026-08-05)

- Network: Monad Testnet (`10143`)
- `CvaAssetRegistry`: `0x38a859695c32eea74b51c0f098039e15e616d5d6`
- `RepoMarketV1`: `0x90535a7176a3b2c251c834b28e11e245622ee808`
- Deployment block: `51054911`
- RWRN01 is enabled in the registry with 6 decimals and issuance-reference hash `0xb5231edafb76c0b32468759cbf2738977bf8504476fde4638a516686c95b5afe`.
- The final synthetic testnet evidence PDF has SHA-256 hash `0xd16689da2bcaf7f8ade3b397024af4a853ad2ec4178bcc0bef7e288b2370f15f` and is stored at `docs/evidence/RWRN01_TESTNET_RECEIVABLE_NOTE.pdf`.
- The authorized UAT issuer wallet signed a USD 100.00 valuation valid through `2026-09-04T11:32:49.000Z`; the active backend valuation hash is `0xa075a91ee2b6428706d4d2064e5ad4ca6047348f73097669d3dffa325671c5a0`.
- The exact 55,682-byte PDF is stored privately in Cloudflare R2 bucket `rwcar-evidence`; authenticated download reproduced the signed evidence hash exactly. The non-secret object key and database record ID are stored in `deployments/monad-testnet.json`.
- Settlement token, Validator, 15 bps fee, 300-second UAT term, 120-second grace, treasury, and entry-pause state were verified directly on-chain after deployment.
- Confirmed owner of both contracts: `0xF7100Bcc9B352f18b80018D7708177C3C04a128D`.
- Cleanverse Validator pool registration succeeded at block `51055960`; `/validator/is_register` returned `registered: true`.
- Active pool rule: minimum tier 30, minimum sub-tier 0, no group/sub-group or country restriction.
- Both known seller and buyer returned `valid: true` through `/validator/verify`, and direct on-chain `complianceVerify(pool, user)` returned `true` for both.
- Two-step ownership acceptance completed: `CvaAssetRegistry` at block `51058614` and `RepoMarketV1` at block `51058621`; both `pendingOwner()` values are now the zero address.
- Full transaction hashes are stored in `deployments/monad-testnet.json`.

## Live Monad demo wallet snapshot (2026-08-04)

- Public wallet: `0x911F99f424D47F08a15fcC771e94dcc2f7252B02`
- Wallet type: EOA
- A-Pass created through the real encrypted Cleanverse UAT `/generate_apass` endpoint using synthetic hackathon KYC explicitly permitted by Cleanverse.
- Synthetic customer ID: `RWCAR20260804MONAD01`
- Cleanverse CV record ID: `886`
- A-Pass status: `1` (active)
- Tier: `50`
- Sub-tier: `0`
- Group/subgroup: empty
- Country tag: `BD`
- Expiration: Unix `1817423999` (2027-08-04 23:59:59 UTC)
- A-Pass generation transaction: `0x06ee41004a617d0ffb492c12f46e59b27b07bb05ed9096da6f113f47c68c9c8b`
- A-Pass transaction status: successful at Monad block `50725294`
- CWRS03 `/verify_apass`: outer `0000`, `data.code: 4` (eligible)
- CWRS03 balance after faucet attempts: `0`
- CWRS03 faucet result after CVI activation: token resolved, but faucet source reverted with `ERC20InsufficientBalance` and zero available CWRS03.
- aUSDC faucet: `0.01` successfully transferred.
- aUSDC faucet transaction: `0xf680199fff58e1d4db3899562b453726680901bc32b8c11d1fa5304400aa8e2e`
- aUSDC transaction status: successful at Monad block `50725530`
- aUSDC balance after transfer: `0.01`

The A-Pass and aUSDC are real UAT/on-chain state. The KYC identity input is synthetic test data under hackathon guidance and must never be described as production identity verification.
