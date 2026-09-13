# Next on Solana — operator runbook

Next is a non-custodial launchpad: every coin is a real SPL token traded on a
[Meteora Dynamic Bonding Curve](https://github.com/MeteoraAg/dynamic-bonding-curve) pool
(program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`). Users sign every transaction with
their own wallet; the platform holds no funds and cannot move anyone's tokens.

The curve config Next launches through is created once per cluster and pins the economics:

| Parameter | Value |
| --- | --- |
| Supply | 1,000,000,000 tokens, 6 decimals, mint and freeze authority revoked |
| Quote currency | SOL |
| Swap fee | 2.7% on every buy and sell |
| Creator share of the fee | 10% (the other 90% goes to the treasury wallet) |
| Launch market cap | ≈ $5,000 |
| Graduation market cap | ≈ $69,000 |
| At graduation | Liquidity migrates to a Meteora DAMM v2 pool; the LP position is permanently locked, split 50/50 between treasury and creator, who keep earning its trading fees |

## 1. Create the config (once per cluster)

```bash
cd pump
npm ci
# devnet rehearsal first
CLUSTER=devnet PAYER=./deployer.json TREASURY=<your-wallet> node scripts/solana/create-config.mjs
# then mainnet
CLUSTER=mainnet-beta PAYER=./deployer.json TREASURY=<your-wallet> node scripts/solana/create-config.mjs
```

`PAYER` is a keypair file (`solana-keygen new -o deployer.json`) holding ~0.05 SOL for rent.
`TREASURY` is the wallet that claims the platform's 90% of the fees. The script prints
`DBC_CONFIG=<address>` and writes `config.<cluster>.json`; put that address in the server's
`DBC_CONFIG` environment variable together with `TREASURY_WALLET`.

The config owner (the payer) can never take user funds — it only defines the curve and
receives the platform fee share.

## 2. Rehearse on devnet

```bash
node scripts/solana/devnet-e2e.mjs
```

Airdrops, creates a pool with a first buy, buys, sells, checks that the fee is exactly 2.7%
and that the creator receives 10% of it, and prints the transaction history the indexer
consumes. It also runs on GitHub Actions (`.github/workflows/solana-devnet-e2e.yml`) because
sandboxes usually cannot reach a Solana RPC.

## 3. Mine "next" mint addresses

Contract addresses that end in `next` are pre-mined and handed out at creation time; when the
pool is empty the platform falls back to a random mint, so launches never block.

```bash
node scripts/solana/grind.mjs --count 10 --out ./vanity
API=https://app.noxia.work ADMIN_API_TOKEN=<token> node scripts/solana/grind.mjs --count 10 --upload
```

The four-character suffix is 1 in 58⁴ ≈ 11.3 million keys. This script does ~5,000 keys/s per
core, so an address costs about 40 core-minutes: a four-core laptop finds one every ten
minutes, and `solana-keygen grind --ends-with next:10` (Rust) is faster still.
Both write the same JSON keypair format, so anything they produce can be uploaded with
`--upload --from <dir>` or posted to `POST /api/admin/vanity` with the `x-admin-token` header.

Keep the keypair files secret until they are used: whoever holds one can create the mint.
Once a mint is used for a pool its authorities are revoked, so a leaked key afterwards is
harmless.

## 4. Point the app at the chain

Server environment:

```
SOLANA_CLUSTER=mainnet-beta
RPC_URL=<a paid RPC endpoint — the public one is rate limited>
DBC_CONFIG=<from step 1>
TREASURY_WALLET=<your wallet>
ADMIN_API_TOKEN=<random secret for the vanity uploader>
```

Use a dedicated RPC provider (Helius, QuickNode, Triton). The public
`api.mainnet-beta.solana.com` endpoint throttles the indexer's `getSignaturesForAddress` and
log subscriptions.

## The devnet test wallet

`scripts/solana/devnet-payer.json` is a throwaway keypair committed on purpose so the
GitHub Actions rehearsal can pay for its own transactions. Devnet SOL has no value and this
key must never hold anything else. Its address is

```
F4mpVG5Wraotomjn9ZLR58njPC5ZM8QXSzHvJ9K4gxph
```

Top it up at <https://faucet.solana.com> (paste the address, pick devnet) whenever the
rehearsal reports an empty balance; the public airdrop endpoint refuses requests coming from
cloud runners, which is why the wallet is funded by hand.
