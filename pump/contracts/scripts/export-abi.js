/**
 * Export the launchpad + token ABIs for the web app (pump/shared/abi/).
 *   npx hardhat run scripts/export-abi.js
 */
const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  await hre.run("compile");
  const outDir = path.join(__dirname, "..", "..", "shared", "abi");
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ["NoxiaLaunchpad", "NoxiaToken"]) {
    const artifact = await hre.artifacts.readArtifact(name);
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
    console.log(`wrote shared/abi/${name}.json (${artifact.abi.length} entries)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
