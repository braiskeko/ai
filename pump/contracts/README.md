# Noxia launchpad contracts

pump.fun-style, non-custodial memecoin launchpad for Base (any EVM chain with Uniswap V2).

- `NoxiaLaunchpad.sol` — factory + bonding curve. Quoted in native ETH. 2.7% fee per swap
  (10% to the coin creator, 90% to the treasury). Sells out → seeds a Uniswap V2 pool at the
  final curve price, burns the LP tokens and the unused reserve, and closes the curve.
- `NoxiaToken.sol` — fixed-supply ERC-20 (1B, 18 decimals), no owner, no mint, no tax.

Curve parameters mirror pump.fun: 793.1M tokens sold on the curve, 206.9M reserved for the
pool, 1.073B virtual token total. The launch virtual ETH reserve is chosen at deploy time
from the Chainlink ETH/USD price so a fresh coin starts near a $5k market cap and graduates
near $69k (≈ 2.8 × the virtual reserve in real ETH collected).

```
npm install
npx hardhat test
npx hardhat run scripts/export-abi.js              # ABIs for the web app
TREASURY=0x... NEW_OWNER=0x... npx hardhat run scripts/deploy.js --network baseSepolia
TREASURY=0x... NEW_OWNER=0x... npx hardhat run scripts/deploy.js --network base
```

`DEPLOYER_PRIVATE_KEY` pays gas; ownership can be handed to `NEW_OWNER` right after
deployment. The deploy writes `deployments/<network>.json` (address, ABI, block) which the
web app's indexer consumes.
