import hre from "hardhat";
import { writeFileSync } from "node:fs";

/**
 * Generates the constructor-argument file needed to verify a GameCore instance
 * on Etherscan.
 *
 * Games are deployed BY the factory, so Etherscan cannot recover their
 * constructor arguments from a normal deployment transaction. We rebuild them
 * by reading the game's own state, which is exactly what was passed in.
 *
 * Usage:
 *   npx hardhat run scripts/gen-verify-args.ts --network sepolia
 *   npx hardhat verify --network sepolia <GAME> --constructor-args-path verify-args.js
 *
 * Only the FIRST v2 game needs this. Once one is verified, Etherscan matches
 * later games automatically by bytecode.
 */

// Pass the game address in, so the generated file can never silently belong to
// a different game than the one being verified:
//   GAME_ADDRESS=0x… npx hardhat run scripts/gen-verify-args.ts --network sepolia
const GAME = process.env.GAME_ADDRESS ?? "";
const OUT = "verify-args.js";

if (!/^0x[0-9a-fA-F]{40}$/.test(GAME)) {
  throw new Error(
    "Set GAME_ADDRESS to the game you are verifying, e.g.\n" +
    "  GAME_ADDRESS=0x3516346b8F6f59744b960fF97b28c4523F8887f9 npx hardhat run scripts/gen-verify-args.ts --network sepolia"
  );
}

async function main() {
  const connection = await hre.network.connect("sepolia");
  const { ethers } = connection;

  const game = await ethers.getContractAt("GameCore", GAME);

  const gameId = await game.gameId();
  const cfg = await game.config();
  const ranks = await game.getRanks();

  const vrf = [
    await game.s_vrfCoordinator(),
    (await game.subscriptionId()).toString(),
    await game.keyHash(),
    Number(await game.callbackGasLimit()),
    Number(await game.requestConfirmations()),
  ];

  // The admin is whichever address createGame() was given; our API always
  // passes the operator wallet. Confirm rather than assume.
  const [signer] = await ethers.getSigners();
  const adminRole = await game.DEFAULT_ADMIN_ROLE();
  const admin = signer.address;
  if (!(await game.hasRole(adminRole, admin))) {
    throw new Error(`${admin} is not this game's admin — cannot rebuild constructor args`);
  }

  const config = [
    cfg.gameCode,
    cfg.gameName,
    cfg.schemeCode,
    cfg.schemeName,
    Number(cfg.mode),
    cfg.ticketPrice.toString(),
    cfg.currency,
    cfg.saleStart.toString(),
    cfg.saleClose.toString(),
    cfg.drawAt.toString(),
    Number(cfg.maxParticipation),
    cfg.currencySymbol,
    Number(cfg.settlementMode),
  ];

  const rankArgs = ranks.map((r: any) => ([
    Number(r.rank),
    Number(r.maxWinners),
    Number(r.prizeCategory),
    r.prizeAmount.toString(),
    Number(r.allocationBps),
    Number(r.prizeType),
    Number(r.claimType),
    r.rankDescription,
  ]));

  const args = [gameId.toString(), admin, vrf, config, rankArgs];

  writeFileSync(OUT, "export default " + JSON.stringify(args, null, 2) + ";\n");

  console.log("Game:      ", GAME);
  console.log("gameCode:  ", cfg.gameCode);
  console.log("currency:  ", cfg.currencySymbol, "| settlementMode:", Number(cfg.settlementMode));
  console.log("ranks:     ", rankArgs.length);
  console.log("\nWrote", OUT);
  console.log("\nNow run:");
  console.log(`  npx hardhat verify --network sepolia ${GAME} --constructor-args-path ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
