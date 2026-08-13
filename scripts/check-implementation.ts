import hre from "hardhat";

/**
 * Confirms whether the live proxy is running the current GameFactory build.
 *
 * NOTE: do NOT compare on-chain code to artifact.deployedBytecode. GameFactory
 * inherits UUPSUpgradeable, which declares `address private immutable __self =
 * address(this)`. Immutables are written into the bytecode at construction, so
 * every deployment differs from the artifact (which holds zeros there) and from
 * every other deployment. Equality comparison always fails and proves nothing.
 *
 * Instead we check for the createGame selector. The game config struct gained
 * two fields in v2, which changes the function signature and therefore the
 * 4-byte selector — so its presence is decisive proof of which build is live.
 */

const PROXY = "0xb7132A1139d552373a8BE2795693417Ea8fDeC65";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const slot = await ethers.provider.getStorage(PROXY, IMPL_SLOT);
  const impl = ethers.getAddress("0x" + slot.slice(-40));
  const onChain = await ethers.provider.getCode(impl);
  const artifact = await hre.artifacts.readArtifact("GameFactory");

  console.log("Proxy:               ", PROXY);
  console.log("Live implementation: ", impl);
  console.log("On-chain size:       ", (onChain.length - 2) / 2, "bytes");
  console.log("Local build size:    ", (artifact.deployedBytecode.length - 2) / 2, "bytes");

  const iface = new ethers.Interface(artifact.abi);
  const selector = iface.getFunction("createGame")!.selector;
  const present = onChain.toLowerCase().includes(selector.slice(2).toLowerCase());

  console.log("\ncreateGame selector (v2):", selector);
  console.log(present ? "  FOUND in the live implementation" : "  NOT FOUND in the live implementation");

  const factory = await ethers.getContractAt("GameFactory", PROXY);
  console.log("\nGames on the factory:", (await factory.getGameCount()).toString());

  if (present) {
    console.log("\nOK — the proxy is running the current build. Safe to create games.");
  } else {
    console.log("\nSTALE — the proxy is still on the old build. Run scripts/upgrade-factory.ts.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
