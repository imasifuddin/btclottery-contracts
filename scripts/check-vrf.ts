import hre from "hardhat";

/**
 * Diagnoses a draw that is stuck in Drawing (status 1).
 *
 * Almost always one of: the subscription is out of LINK, the game was never
 * added as a consumer, or Chainlink simply has not responded yet.
 *
 * Usage: set GAME below, then
 *   npx hardhat run scripts/check-vrf.ts --network sepolia
 */

const GAME = "0x307464EfB55e08D20cd40930C9a044AC9eD27611";
const COORDINATOR = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B";

const COORDINATOR_ABI = [
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  // Non-zero while a request is accepted and awaiting fulfilment; cleared once fulfilled.
  "function s_requestCommitments(uint256 requestId) view returns (bytes32)",
];

const STATUS = ["Open", "Drawing", "SeedReceived", "Finalizing", "Finalized"];

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const game = await ethers.getContractAt("GameCore", GAME);
  const status = Number(await game.status());
  const requestId = await game.s_requestId();
  const seed = await game.drawSeed();
  const subId = await game.subscriptionId();

  console.log("Game:        ", GAME);
  console.log("Status:      ", status, `(${STATUS[status]})`);
  console.log("VRF requestId:", requestId.toString());
  console.log("Draw seed:   ", seed.toString(), seed === 0n ? "(not yet delivered)" : "(delivered)");
  console.log("Participants:", (await game.participantCount()).toString());

  const coordinator = new ethers.Contract(COORDINATOR, COORDINATOR_ABI, ethers.provider);
  const sub = await coordinator.getSubscription(subId);

  const link = Number(ethers.formatEther(sub.balance));
  console.log("\nSubscription:", subId.toString());
  console.log("LINK balance:", link.toFixed(4));
  console.log("Requests made:", sub.reqCount.toString());

  const consumers: string[] = sub.consumers.map((c: string) => c.toLowerCase());
  const isConsumer = consumers.includes(GAME.toLowerCase());
  console.log("Consumers registered:", consumers.length);
  console.log("This game is a consumer:", isConsumer ? "YES" : "NO");

  // Decisive: did the coordinator actually accept and record this request?
  let commitment = "0x" + "0".repeat(64);
  try {
    commitment = await coordinator.s_requestCommitments(requestId);
  } catch {
    console.log("(could not read request commitment on this coordinator)");
  }
  const pendingOnCoordinator = /[1-9a-f]/i.test(commitment.slice(2));
  console.log("Request accepted by coordinator:", pendingOnCoordinator ? "YES — pending fulfilment" : "NO commitment stored");

  console.log("\n--- Diagnosis ---");
  if (status === 0) {
    console.log("No draw has been requested yet.");
  } else if (status >= 2) {
    console.log("Seed delivered. Run the finalize endpoint to compute winners.");
  } else if (!isConsumer) {
    console.log("PROBLEM: the game is not a registered consumer, so Chainlink will");
    console.log("never fulfil. Add it at vrf.chain.link, then the pending request");
    console.log("will be answered.");
  } else if (link < 0.5) {
    console.log(`PROBLEM: only ${link.toFixed(4)} LINK left — likely too little to fulfil.`);
    console.log("Top up the subscription at vrf.chain.link; the pending request");
    console.log("will then be answered automatically.");
  } else if (pendingOnCoordinator) {
    console.log("The coordinator has accepted the request and is holding it open.");
    console.log("Config is fine — this is Chainlink's side to fulfil. Sepolia is");
    console.log("usually 1-3 minutes but can stretch much longer when congested.");
    console.log("Watch it live at https://vrf.chain.link (Sepolia, your subscription).");
  } else {
    console.log("PROBLEM: the game holds a requestId but the coordinator has no");
    console.log("matching open request. Either it was already fulfilled (seed would");
    console.log("be set — it is not), or the request never registered. Check the");
    console.log("requestDraw transaction on Etherscan for a RandomWordsRequested event.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
