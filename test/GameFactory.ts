import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
const BASE_FEE = "100000000000000000";
const GAS_PRICE_LINK = "1000000000";

describe("GameFactory", function () {
  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);
    const [admin, operator, stranger] = await ethers.getSigners();

    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const coordinator = await MockCoordinator.deploy(BASE_FEE, GAS_PRICE_LINK, "4000000000000000");
    await coordinator.waitForDeployment();
    const subTx = await coordinator.createSubscription();
    const subRc = await subTx.wait();
    const subLog = subRc!.logs.find((l: any) => l.fragment?.name === "SubscriptionCreated") as any;
    const subId: bigint = subLog.args[0];
    await coordinator.fundSubscription(subId, ethers.parseEther("1000"));

    const Factory = await ethers.getContractFactory("GameFactory");
    const factory = await upgradesApi.deployProxy(
      Factory,
      [{
        admin: admin.address,
        vrfCoordinator: await coordinator.getAddress(),
        vrfSubscriptionId: subId,
        vrfKeyHash: KEY_HASH,
        vrfCallbackGasLimit: 2_000_000,
        vrfRequestConfirmations: 3,
      }],
      { kind: "uups" }
    );
    await factory.waitForDeployment();

    const GAME_CREATOR_ROLE = await factory.GAME_CREATOR_ROLE();

    const block = await ethers.provider.getBlock("latest");
    const now = block!.timestamp;

    // Taaher's exact payload, converted the way our API will convert it
    const taaherCfg = {
      gameCode: "GAME0011",
      gameName: "Api-test",
      schemeCode: "SCH0002",
      schemeName: "Jackpot Pool Allocation",
      mode: 0, // COUNT
      ticketPrice: ethers.parseEther("0.1"),
      currency: ZeroAddress, // "ETH"
      saleStart: BigInt(now - 60),
      saleClose: BigInt(now + 3600),
      drawAt: 0n,
      maxParticipation: 9993,
    };
    const taaherRanks = [
      { rank: 1, maxWinners: 1,   prizeCategory: 1, prizeAmount: 0n, allocationBps: 5000, prizeType: 1, claimType: 1, rankDescription: "Jackpot" },
      { rank: 2, maxWinners: 10,  prizeCategory: 1, prizeAmount: 0n, allocationBps: 2500, prizeType: 1, claimType: 2, rankDescription: "Runner Up" },
      { rank: 3, maxWinners: 50,  prizeCategory: 1, prizeAmount: 0n, allocationBps: 1500, prizeType: 1, claimType: 0, rankDescription: "Third Tier" },
      { rank: 4, maxWinners: 500, prizeCategory: 1, prizeAmount: 0n, allocationBps: 1000, prizeType: 1, claimType: 0, rankDescription: "Fourth Tier" },
    ];

    return { ethers, upgradesApi, factory, Factory, coordinator, subId, admin, operator, stranger, GAME_CREATOR_ROLE, now, taaherCfg, taaherRanks };
  }

  it("deploys a game from Taaher's exact payload and stores it permanently", async function () {
    const { ethers, factory, admin, taaherCfg, taaherRanks } = await setup();
    const tx = await factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address);
    await tx.wait();

    expect(await factory.getGameCount()).to.equal(1n);
    const addr = await factory.getGameByCode("GAME0011");
    expect(addr).to.equal(await factory.getGame(0n));

    const game = (await ethers.getContractFactory("GameCore")).attach(addr);
    const cfg = await game.config();
    expect(cfg.gameCode).to.equal("GAME0011");
    expect(cfg.schemeName).to.equal("Jackpot Pool Allocation");
    expect(cfg.maxParticipation).to.equal(9993);
    const ranks = await game.getRanks();
    expect(ranks.length).to.equal(4);
    expect(ranks[0].allocationBps).to.equal(5000);
    expect(ranks[1].claimType).to.equal(2); // MANUAL
    expect(ranks[3].maxWinners).to.equal(500);
  });

  it("emits GameCreated with payload correlation fields", async function () {
    const { factory, admin, taaherCfg, taaherRanks } = await setup();
    await expect(factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address))
      .to.emit(factory, "GameCreated");
  });

  it("is fully dynamic: deploys a completely different payload shape (AMOUNT + DRAW_TIME, 2 ranks)", async function () {
    const { ethers, factory, admin, now } = await setup();
    const cfg = {
      gameCode: "GAME0099", gameName: "Fixed Daily", schemeCode: "SCH0009", schemeName: "Std Fixed",
      mode: 1, ticketPrice: ethers.parseEther("0.05"), currency: ZeroAddress,
      saleStart: BigInt(now - 60), saleClose: BigInt(now + 1800), drawAt: BigInt(now + 3600), maxParticipation: 0,
    };
    const ranks = [
      { rank: 1, maxWinners: 1, prizeCategory: 0, prizeAmount: ethers.parseEther("2"),   allocationBps: 0, prizeType: 1, claimType: 1, rankDescription: "Grand" },
      { rank: 2, maxWinners: 3, prizeCategory: 0, prizeAmount: ethers.parseEther("0.5"), allocationBps: 0, prizeType: 0, claimType: 0, rankDescription: "Second" },
    ];
    await factory.connect(admin).createGame(cfg, ranks, admin.address);
    const game = (await ethers.getContractFactory("GameCore")).attach(await factory.getGameByCode("GAME0099"));
    expect((await game.config()).mode).to.equal(1);
    expect((await game.getRanks())[0].prizeAmount).to.equal(ethers.parseEther("2"));
  });

  it("rejects duplicate gameCode", async function () {
    const { factory, admin, taaherCfg, taaherRanks } = await setup();
    await factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address);
    await expect(factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address))
      .to.be.revertedWithCustomError(factory, "GameCodeExists");
  });

  it("rejects callers without GAME_CREATOR_ROLE and blocks creation when paused", async function () {
    const { factory, admin, stranger, GAME_CREATOR_ROLE, taaherCfg, taaherRanks } = await setup();
    await expect(factory.connect(stranger).createGame(taaherCfg, taaherRanks, stranger.address))
      .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, GAME_CREATOR_ROLE);
    await factory.connect(admin).pause();
    await expect(factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address))
      .to.be.revertedWithCustomError(factory, "EnforcedPause");
  });

  it("rejects invalid payloads (bad sale window, missing cap, alloc > 100%, zero winners)", async function () {
    const { ethers, factory, admin, now, taaherCfg, taaherRanks } = await setup();
    const Game = await ethers.getContractFactory("GameCore");

    await expect(factory.connect(admin).createGame(
      { ...taaherCfg, gameCode: "B1", saleStart: BigInt(now + 100), saleClose: BigInt(now + 50) },
      taaherRanks, admin.address
    )).to.be.revertedWithCustomError(Game, "InvalidParam");

    await expect(factory.connect(admin).createGame(
      { ...taaherCfg, gameCode: "B2", maxParticipation: 0 },
      taaherRanks, admin.address
    )).to.be.revertedWithCustomError(Game, "InvalidParam");

    const overAlloc = taaherRanks.map(r => ({ ...r, allocationBps: 4000 }));
    await expect(factory.connect(admin).createGame(
      { ...taaherCfg, gameCode: "B3" }, overAlloc, admin.address
    )).to.be.revertedWithCustomError(Game, "InvalidParam");

    const zeroWin = [{ ...taaherRanks[0], maxWinners: 0 }];
    await expect(factory.connect(admin).createGame(
      { ...taaherCfg, gameCode: "B4" }, zeroWin, admin.address
    )).to.be.revertedWithCustomError(Game, "InvalidParam");
  });

  it("upgrades (UUPS) preserving the game index; non-admin upgrade reverts", async function () {
    const { ethers, upgradesApi, factory, admin, stranger, taaherCfg, taaherRanks } = await setup();
    await factory.connect(admin).createGame(taaherCfg, taaherRanks, admin.address);

    const FactoryV2 = await ethers.getContractFactory("GameFactory");
    const upgraded = await upgradesApi.upgradeProxy(await factory.getAddress(), FactoryV2, { kind: "uups" });
    expect(await upgraded.getGameCount()).to.equal(1n);
    expect(await upgraded.getGameByCode("GAME0011")).to.be.properAddress;

    const FactoryStranger = await ethers.getContractFactory("GameFactory", stranger);
    await expect(
      upgradesApi.upgradeProxy(await factory.getAddress(), FactoryStranger, { kind: "uups" })
    ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");
  });
});
