# Privy agent signer policy

The Privy authorization key is a second enforcement layer around RWCAR's semantic intent engine. Configure a deny-by-default policy for one P-256 signer. The signer may submit only Monad Testnet (`eip155:10143`) transactions with zero native value to reviewed RWCAR contracts or exact admitted token contracts.

Do not paste the authorization private key into the Privy dashboard, Agent Console, API, web service, logs, or chat. Register only the public key. The private key belongs only in `PRIVY_AGENT_AUTHORIZATION_PRIVATE_KEYS` on the isolated executor.

## Policy construction checklist

Use the addresses in the reviewed active deployment manifest, not copied documentation. For the current UAT release they are under `deployments/monad-testnet-v2-hackathon.json`.

1. Restrict chain to Monad Testnet, chain ID `10143`.
2. Require transaction native value to equal zero.
3. Allow `eth_sendTransaction`; deny raw message signing, arbitrary typed-data signing, wallet export/import, ownership changes, policy changes, and all unlisted RPC methods.
4. Allow only the exact destinations and selectors below.
5. On ERC-20 `approve`, allow only the manifest-pinned RWRN01/aUSDC token addresses. If the policy system supports calldata conditions, restrict spender to the matching collateral vault, RepoMarketV2, or MarginEngineV2 and set a bounded amount. The API independently requires the exact preflight amount and graph-approved spender.
6. Do not allow calls to governance, factory, validator, registry administration, oracle administration, risk administration, treasury administration, token minting, or rescue methods.
7. Attach this policy as the additional signer's override policy to each fresh agent wallet.
8. Record the policy ID, signer ID, policy export/screenshot, creation actor, timestamp, and manifest revision in release evidence.

## Selector allowlist

### RepoMarketV2 destination

| Function | Selector |
| --- | --- |
| `depositCollateral` | `0xa5d5db0c` |
| `withdrawCollateral` | `0x1f1088a0` |
| `createOffer` | `0x94449279` |
| `fillOffer` | `0x50afddd9` |
| `cancelOffer` | `0xef706adf` |
| `finalizeOfferExpiry` | `0x46fcd5f2` |
| `repurchase` | `0x5e99cd2d` |
| `startAuction` | `0x065de74c` |
| `claimDefaultCollateral` | `0xe41936d7` |
| `claimCollateralOnOracleFailure` | `0xcf406143` |
| `buyAuction` | `0x4a5d1516` |
| `finalizeFailedAuction` | `0xcd4438bb` |

### SettlementEscrowV2 destination

| Function | Selector |
| --- | --- |
| `claim` | `0xac44ff31` |

### MarginEngineV2 destination

| Function | Selector |
| --- | --- |
| `depositCollateral` | `0xbad4a01f` |
| `withdrawAvailable` | `0x6f401d0b` |
| `openMarginAccount` | `0x02e5234c` |
| `addMarginCollateral` | `0x3cd745ed` |
| `withdrawExcessCollateral` | `0x9160d3e3` |
| `fundMarginAccount` | `0xb8688e41` |
| `closeFunding` | `0xab473f48` |
| `repayExposure` | `0x62ba80fa` |
| `declarePaymentDefault` | `0xc7b72fc9` |
| `openMarginCall` | `0x12cd6a64` |
| `cureMarginCall` | `0xd6fbd35e` |
| `startMarginLiquidation` | `0x98f81bff` |
| `buyMarginAuction` | `0x082f5c19` |
| `finalizeFailedMarginAuction` | `0x779dc5fd` |
| `startInKindOracleFallback` | `0x400f8e1d` |
| `materializeLiquidationClaim` | `0xcf26cb21` |
| `claimFailedCollateral` | `0xda4eece9` |
| `closeMarginAccount` | `0x0ee6df26` |

### Admitted ERC-20 token destinations

| Function | Selector |
| --- | --- |
| `approve` | `0x095ea7b3` |

Selector values are release evidence, not an instruction to hard-code addresses. Recompute selectors from the committed ABI and compare them during every policy revision.

## Rotation

The reviewed binding is immutable per agent. To rotate the authorization key or policy, pause the old agent, wait for submitted transactions to reach a terminal reconciled state, revoke its credentials and agent record, create a new key/policy if needed, then provision a new dedicated wallet and signed mandate. Never silently change a policy ID beneath an existing mandate.

JWT signing keys, executor API keys, OAuth client credentials, and Privy signer keys are separate rotation domains. Do not reuse one key for another purpose.
