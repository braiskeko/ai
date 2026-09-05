/**
 * Deploy NoxiaLaunchpad.
 *
 *   TREASURY=0x... LAUNCH_MCAP_USD=5000 npx hardhat run scripts/deploy.js --network base
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  pays for gas (see hardhat.config.js)
 *   TREASURY              wallet that receives 90% of the fees (required)
 *   NEW_OWNER             optional; ownership is transferred here after deployment
 *   LAUNCH_MCAP_USD       target market cap of a fresh coin in USD (default 5000)
 *   ROUTER / ETH_USD_FEED optional overrides of the per-network defaults below
 */
const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  // Uniswap V2 Router02 + Chainlink ETH/USD
  base: { router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
  baseSepolia: { router: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602", feed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1" },
};

const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ROUTER_ABI = ["function WETH() view returns (address)", "function factory() view returns (address)"];

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY missing");
  const treasury = process.env.TREASURY?.trim();
  if (!treasury || !ethers.isAddress(treasury)) throw new Error("TREASURY must be a valid address");
  const defaults = DEFAULTS[network.name] ?? {};
  const routerAddr = process.env.ROUTER?.trim() || defaults.router;
  const feedAddr = process.env.ETH_USD_FEED?.trim() || defaults.feed;
  if (!routerAddr) throw new Error(`no Uniswap V2 router known for network ${network.name}; set ROUTER`);
  const launchMcapUsd = Number(process.env.LAUNCH_MCAP_USD || "5000");

  console.log(`network ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`deployer ${deployer.address} balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // Sanity-check the router before spending gas on the constructor.
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, ethers.provider);
  const weth = await router.WETH();
  const factory = await router.factory();
  console.log(`router ${routerAddr} -> WETH ${weth}, factory ${factory}`);

  // ETH/USD from Chainlink so the launch market cap lands near LAUNCH_MCAP_USD.
  let ethUsd = Number(process.env.ETH_USD || "0");
  if (!ethUsd && feedAddr) {
    const feed = new ethers.Contract(feedAddr, FEED_ABI, ethers.provider);
    const [, answer] = await feed.latestRoundData();
    const dec = Number(await feed.decimals());
    ethUsd = Number(answer) / 10 ** dec;
  }
  if (!ethUsd) throw new Error("could not determine ETH/USD; set ETH_USD");
  // launch mcap = vE / VIRTUAL_TOKEN_TOTAL * TOTAL_SUPPLY = vE / 1.073  ->  vE = mcap * 1.073
  const virtualEth = ethers.parseEther(((launchMcapUsd / ethUsd) * 1.073).toFixed(6));
  console.log(`ETH/USD ${ethUsd.toFixed(2)} -> launch virtual reserve ${ethers.formatEther(virtualEth)} ETH (≈ $${launchMcapUsd} launch mcap, ≈ $${Math.round(launchMcapUsd * 13.7)} at graduation)`);

  const Launchpad = await ethers.getContractFactory("NoxiaLaunchpad");
  const pad = await Launchpad.deploy(routerAddr, treasury, virtualEth);
  console.log(`deploy tx ${pad.deploymentTransaction().hash}`);
  await pad.waitForDeployment();
  const address = await pad.getAddress();
  console.log(`NoxiaLaunchpad deployed at ${address}`);

  const newOwner = process.env.NEW_OWNER?.trim();
  if (newOwner && ethers.isAddress(newOwner) && newOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    const tx = await pad.transferOwnership(newOwner);
    await tx.wait();
    console.log(`ownership transferred to ${newOwner}`);
  }

  const artifact = await hre.artifacts.readArtifact("NoxiaLaunchpad");
  const tokenArtifact = await hre.artifacts.readArtifact("NoxiaToken");
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    launchpad: address,
    router: routerAddr,
    weth,
    treasury,
    owner: newOwner || deployer.address,
    ethUsdFeed: feedAddr || null,
    launchVirtualEth: virtualEth.toString(),
    deployBlock: (await ethers.provider.getBlockNumber()),
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
    tokenAbi: tokenArtifact.abi,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
