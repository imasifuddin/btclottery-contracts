import hre from "hardhat";

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const PROXY = "0xb7132A1139d552373a8BE2795693417Ea8fDeC65";
  const factory = await ethers.getContractAt("GameFactory", PROXY);

  const [signer] = await ethers.getSigners();
  console.log("Operator wallet:", signer.address);

  const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
  const GAME_CREATOR_ROLE = await factory.GAME_CREATOR_ROLE();

  console.log("Game count:", (await factory.getGameCount()).toString());
  console.log("VRF coordinator:", await factory.vrfCoordinator());
  console.log("VRF subscription:", (await factory.vrfSubscriptionId()).toString());
  console.log("Admin role held by operator:", await factory.hasRole(DEFAULT_ADMIN_ROLE, signer.address));
  console.log("Creator role held by operator:", await factory.hasRole(GAME_CREATOR_ROLE, signer.address));
}

main().catch((e) => { console.error(e); process.exit(1); });
