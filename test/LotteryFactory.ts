import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
const CALLBACK_GAS_LIMIT = 500_000;
const REQUEST_CONFIRMATIONS = 3;
const BASE_FEE = "100000000000000000";
const GAS_PRICE_LINK = "1000000000";

describe("LotteryFactory", function () {

  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);

    const [admin, lotteryCreator, pauser, stranger, feeRecipient] =
      await ethers.getSigners();

    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const mockCoordinator = await MockCoordinator.deploy(BASE_FEE, GAS_PRICE_LINK, "4000000000000000");
    await mockCoordinator.waitForDeployment();

    const createSubTx = await mockCoordinator.createSubscription();
    const receipt = await createSubTx.wait();
    const subLog = receipt!.logs.find((l: any) => l.fragment?.name === "SubscriptionCreated") as any;
    const subscriptionId: bigint = subLog.args[0];
    await mockCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    const Registry = await ethers.getContractFactory("PrizeSchemeRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    await registry.connect(admin).createScheme("Standard 3-tier", [5000n, 3000n, 1000n], 500n, false);
    const schemeId = 0n;

    const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
    const factory = await upgradesApi.deployProxy(
      LotteryFactory,
      [{
        admin: admin.address,
        feeRecipient: feeRecipient.address,
        vrfCoordinator: await mockCoordinator.getAddress(),
        vrfSubscriptionId: subscriptionId,
        vrfKeyHash: KEY_HASH,
        vrfCallbackGasLimit: CALLBACK_GAS_LIMIT,
        vrfRequestConfirmations: REQUEST_CONFIRMATIONS,
        prizeSchemeRegistry: await registry.getAddress(),
      }],
      { kind: "uups" }
    );
    await factory.waitForDeployment();

    const LOTTERY_CREATOR_ROLE = await factory.LOTTERY_CREATOR_ROLE();
    const PAUSER_ROLE          = await factory.PAUSER_ROLE();
    const DEFAULT_ADMIN_ROLE   = await factory.DEFAULT_ADMIN_ROLE();

    const block    = await ethers.provider.getBlock("latest");
    const drawTime = BigInt(block!.timestamp + 3600);

    return {
      ethers, upgradesApi, factory, mockCoordinator, subscriptionId, registry, schemeId,
      admin, lotteryCreator, pauser, stranger, feeRecipient,
      LOTTERY_CREATOR_ROLE, PAUSER_ROLE, DEFAULT_ADMIN_ROLE, drawTime,
    };
  }

  describe("Deployment", function () {
    it("Should deploy via UUPS proxy successfully", async function () {
      const { factory } = await setup();
      expect(await factory.getAddress()).to.be.properAddress;
    });

    it("Should grant all three roles to admin", async function () {
      const { factory, admin, LOTTERY_CREATOR_ROLE, PAUSER_ROLE, DEFAULT_ADMIN_ROLE } =
        await setup();
      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await factory.hasRole(LOTTERY_CREATOR_ROLE, admin.address)).to.be.true;
      expect(await factory.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("Should start with zero lotteries", async function () {
      const { factory } = await setup();
      expect(await factory.getLotteryCount()).to.equal(0n);
    });

    it("Should store registry address", async function () {
      const { factory, registry } = await setup();
      expect(await factory.prizeSchemeRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe("createLottery()", function () {
    it("Should deploy a LotteryCore referencing the given scheme", async function () {
      const { factory, drawTime, schemeId, ethers } = await setup();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime, schemeId);

      expect(await factory.getLotteryCount()).to.equal(1n);
      const lotteryAddr = await factory.getLottery(0n);
      const LotteryCore = await ethers.getContractFactory("LotteryCore");
      const lottery = LotteryCore.attach(lotteryAddr);
      expect(await lottery.schemeId()).to.equal(schemeId);
      expect(await lottery.tierCount()).to.equal(3n);
    });

    it("Should emit LotteryCreated event with schemeId", async function () {
      const { factory, admin, drawTime, schemeId, ethers } = await setup();
      const tx = await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime, schemeId);
      const lotteryAddress = await factory.getLottery(0n);
      await expect(tx)
        .to.emit(factory, "LotteryCreated")
        .withArgs(0n, lotteryAddress, admin.address, schemeId);
    });

    it("Should revert without LOTTERY_CREATOR_ROLE", async function () {
      const { factory, stranger, LOTTERY_CREATOR_ROLE, drawTime, schemeId, ethers } = await setup();
      await expect(
        factory.connect(stranger).createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime, schemeId)
      ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, LOTTERY_CREATOR_ROLE);
    });
  });

  describe("Pause / Unpause", function () {
    it("Should pause and block createLottery", async function () {
      const { factory, drawTime, schemeId, ethers } = await setup();
      await factory.pause();
      await expect(
        factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime, schemeId)
      ).to.be.revertedWithCustomError(factory, "EnforcedPause");
    });
  });

  describe("Upgradeability (UUPS)", function () {
    it("Should upgrade and preserve state", async function () {
      const { factory, upgradesApi, ethers, drawTime, schemeId } = await setup();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime, schemeId);
      expect(await factory.getLotteryCount()).to.equal(1n);

      const LotteryFactoryV2 = await ethers.getContractFactory("LotteryFactory");
      const upgraded = await upgradesApi.upgradeProxy(
        await factory.getAddress(), LotteryFactoryV2, { kind: "uups" }
      );
      await upgraded.waitForDeployment();
      expect(await upgraded.getLotteryCount()).to.equal(1n);
    });
  });
});
