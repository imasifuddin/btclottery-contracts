import hre from "hardhat";

/**
 * Upgrades the GameFactory UUPS proxy to the currently compiled implementation.
 *
 * Done directly rather than through the upgrades plugin: this proxy was
 * originally deployed with Ignition, so the plugin has no manifest entry for
 * it. Registering one with forceImport makes the plugin treat the NEW source
 * as the proxy's existing baseline, after which it decides nothing has changed
 * and silently skips the upgrade. A UUPS upgrade is just upgradeToAndCall() on
 * the proxy, so we call it ourselves and verify the result.
 *
 * Safe because GameFactory.sol itself is unchanged — its storage layout is
 * identical. Only the GameCore bytecode it embeds and the createGame calldata
 * shape have moved, neither of which touches proxy storage.
 *
 * Run:
 *   npx hardhat run scripts/upgrade-factory.ts --network sepolia
 *
 * Then verify the printed implementation address on Etherscan.
 * Never perform this upgrade manually through Etherscan.
 */

const PROXY = "0xb7132A1139d552373a8BE2795693417Ea8fDeC65";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function readImplementation(ethers: any): Promise<string> {
  const slot = await ethers.provider.getStorage(PROXY, IMPL_SLOT);
  return ethers.getAddress("0x" + slot.slice(-40));
}

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const [signer] = await ethers.getSigners();
  console.log("Upgrading with:", signer.address);
  console.log("Proxy:         ", PROXY);

  const proxy = await ethers.getContractAt("GameFactory", PROXY);
  const gamesBefore = await proxy.getGameCount();
  const adminRole = await proxy.DEFAULT_ADMIN_ROLE();

  if (!(await proxy.hasRole(adminRole, signer.address))) {
    throw new Error(`${signer.address} does not hold DEFAULT_ADMIN_ROLE — the upgrade would revert`);
  }

  const implBefore = await readImplementation(ethers);
  console.log("Games before:  ", gamesBefore.toString());
  console.log("Implementation before:", implBefore);

  // 1. Deploy the new implementation. Its constructor only disables
  //    initializers; all real state lives in the proxy.
  console.log("\nDeploying new implementation…");
  const Factory = await ethers.getContractFactory("GameFactory");
  const newImpl = await Factory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log("Deployed at:", newImplAddress);

  // 2. Sanity check before pointing the proxy at it. We check for the v2
  //    createGame selector rather than comparing bytecode: UUPSUpgradeable
  //    declares an immutable `__self = address(this)`, so deployed code always
  //    differs from the artifact (and between deployments) in that slot.
  const artifact = await hre.artifacts.readArtifact("GameFactory");
  const deployedCode = await ethers.provider.getCode(newImplAddress);
  const selector = new ethers.Interface(artifact.abi).getFunction("createGame")!.selector;
  if (!deployedCode.toLowerCase().includes(selector.slice(2).toLowerCase())) {
    throw new Error("Deployed implementation does not expose the v2 createGame — aborting before upgrade");
  }
  console.log("Verified it exposes the v2 createGame selector:", selector);

  // 3. Point the proxy at it. No initializer call: storage is already set up.
  console.log("\nSwitching the proxy over…");
  const tx = await proxy.upgradeToAndCall(newImplAddress, "0x");
  console.log("Upgrade tx:", tx.hash);
  await tx.wait();

  // 4. Verify it actually moved, and that proxy storage survived.
  const implAfter = await readImplementation(ethers);
  const gamesAfter = await proxy.getGameCount();
  console.log("\nImplementation after: ", implAfter);
  console.log("Games after:          ", gamesAfter.toString());

  if (implAfter.toLowerCase() !== newImplAddress.toLowerCase()) {
    throw new Error("Proxy is not pointing at the new implementation — upgrade failed");
  }
  if (gamesAfter !== gamesBefore) {
    throw new Error("Game index changed across the upgrade — investigate before creating any game");
  }

  console.log("\nUpgrade complete. Proxy address unchanged:", PROXY);
  console.log("Next: npx hardhat verify --network sepolia", newImplAddress);
}

main().catch((e) => { console.error(e); process.exit(1); });
