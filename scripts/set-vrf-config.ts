import hre from "hardhat";

/**
 * Retunes the VRF settings the factory applies to NEW games.
 *
 * Why this matters: Chainlink reserves subscription funds against the declared
 * callbackGasLimit priced at the gas lane's MAXIMUM gas price — not against what
 * the callback actually uses. Our callback only stores the seed and emits an
 * event (~50k gas), so the original 2,000,000 limit was demanding a reserve of
 * ~287 LINK per draw. At 100,000 that falls to roughly 40.
 *
 * Games already deployed are unaffected — their VRF settings are immutable.
 *
 * Run:  npx hardhat run scripts/set-vrf-config.ts --network sepolia
 */

const PROXY = "0xb7132A1139d552373a8BE2795693417Ea8fDeC65";
const NEW_CALLBACK_GAS_LIMIT = 100_000;

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("GameFactory", PROXY);

  const adminRole = await factory.DEFAULT_ADMIN_ROLE();
  if (!(await factory.hasRole(adminRole, signer.address))) {
    throw new Error(`${signer.address} does not hold DEFAULT_ADMIN_ROLE`);
  }

  // Read the current values and change ONLY the gas limit — no retyping the
  // 77-digit subscription id, and no risk of clobbering the key hash.
  const subId = await factory.vrfSubscriptionId();
  const keyHash = await factory.vrfKeyHash();
  const gasLimit = await factory.vrfCallbackGasLimit();
  const confirmations = await factory.vrfRequestConfirmations();

  console.log("Current settings");
  console.log("  subscription: ", subId.toString());
  console.log("  keyHash:      ", keyHash);
  console.log("  callbackGas:  ", gasLimit.toString());
  console.log("  confirmations:", confirmations.toString());

  if (Number(gasLimit) === NEW_CALLBACK_GAS_LIMIT) {
    console.log("\nAlready set to", NEW_CALLBACK_GAS_LIMIT, "— nothing to do.");
    return;
  }

  console.log(`\nUpdating callbackGasLimit ${gasLimit} -> ${NEW_CALLBACK_GAS_LIMIT}…`);
  const tx = await factory.setVrfConfig(subId, keyHash, NEW_CALLBACK_GAS_LIMIT, confirmations);
  console.log("tx:", tx.hash);
  await tx.wait();

  const after = await factory.vrfCallbackGasLimit();
  if (Number(after) !== NEW_CALLBACK_GAS_LIMIT) {
    throw new Error(`callbackGasLimit is ${after}, expected ${NEW_CALLBACK_GAS_LIMIT}`);
  }

  console.log("\nDone. callbackGasLimit is now", after.toString());
  console.log("Applies to games created from here on; existing games keep their own.");
}

main().catch((e) => { console.error(e); process.exit(1); });
