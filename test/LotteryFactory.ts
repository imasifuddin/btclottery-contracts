import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

describe("LotteryFactory", function () {

  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);

    const [admin, lotteryCreator, pauser, stranger, feeRecipient] =
      await ethers.getSigners();

    const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
    const factory = await upgradesApi.deployProxy(
      LotteryFactory,
      [admin.address, 500n, feeRecipient.address],
      { kind: "uups" }
    );
    await factory.waitForDeployment();

    const LOTTERY_CREATOR_ROLE = await factory.LOTTERY_CREATOR_ROLE();
    const PAUSER_ROLE = await factory.PAUSER_ROLE();
    const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();

    const block = await ethers.provider.getBlock("latest");
    const drawTime = BigInt(block!.timestamp + 3600);

    return {
      ethers,
      upgradesApi,
      factory,
      admin,
      lotteryCreator,
      pauser,
      stranger,
      feeRecipient,
      LOTTERY_CREATOR_ROLE,
      PAUSER_ROLE,
      DEFAULT_ADMIN_ROLE,
      drawTime,
    };
  }

  describe("Deployment", function () {
    it("Should deploy via UUPS proxy successfully", async function () {
      const { factory } = await setup();
      expect(await factory.getAddress()).to.be.properAddress;
    });

    it("Should revert if initialized with zero address admin", async function () {
      const connection = await hre.network.create();
      const { ethers } = connection;
      const upgradesApi = await upgrades(hre, connection);
      const [, , , , feeRecipient] = await ethers.getSigners();
      const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
      await expect(
        upgradesApi.deployProxy(
          LotteryFactory,
          [ZeroAddress, 500n, feeRecipient.address],
          { kind: "uups" }
        )
      ).to.be.revertedWith("LotteryFactory: admin is zero address");
    });

    it("Should grant all three roles to admin on initialize", async function () {
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

    it("Should store default fee config", async function () {
      const { factory, feeRecipient } = await setup();
      expect(await factory.defaultFeeBps()).to.equal(500n);
      expect(await factory.defaultFeeRecipient()).to.equal(feeRecipient.address);
    });
  });

  describe("createLottery()", function () {
    it("Should deploy a LotteryCore and register it", async function () {
      const { factory, drawTime, ethers } = await setup();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      expect(await factory.getLotteryCount()).to.equal(1n);
      expect(await factory.getLottery(0n)).to.be.properAddress;
    });

    it("Should emit LotteryCreated event", async function () {
      const { factory, admin, drawTime, ethers } = await setup();
      const tx = await factory.createLottery(
        ethers.parseEther("0.1"), 100n, 5n, drawTime
      );
      const lotteryAddress = await factory.getLottery(0n);
      await expect(tx)
        .to.emit(factory, "LotteryCreated")
        .withArgs(0n, lotteryAddress, admin.address);
    });

    it("Should correctly assign sequential IDs", async function () {
      const { factory, drawTime, ethers } = await setup();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      expect(await factory.getLotteryCount()).to.equal(3n);
      expect((await factory.getAllLotteries()).length).to.equal(3);
    });

    it("Should revert when called without LOTTERY_CREATOR_ROLE", async function () {
      const { factory, stranger, LOTTERY_CREATOR_ROLE, drawTime, ethers } = await setup();
      await expect(
        factory.connect(stranger).createLottery(
          ethers.parseEther("0.1"), 100n, 5n, drawTime
        )
      )
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, LOTTERY_CREATOR_ROLE);
    });
  });

  describe("Pause / Unpause", function () {
    it("Should pause and block createLottery", async function () {
      const { factory, drawTime, ethers } = await setup();
      await factory.pause();
      await expect(
        factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime)
      ).to.be.revertedWithCustomError(factory, "EnforcedPause");
    });

    it("Should unpause and allow createLottery", async function () {
      const { factory, drawTime, ethers } = await setup();
      await factory.pause();
      await factory.unpause();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      expect(await factory.getLotteryCount()).to.equal(1n);
    });

    it("Should revert pause from non-pauser", async function () {
      const { factory, stranger, PAUSER_ROLE } = await setup();
      await expect(factory.connect(stranger).pause())
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, PAUSER_ROLE);
    });
  });

  describe("Upgradeability (UUPS)", function () {
    it("Should upgrade and preserve state", async function () {
      const { factory, upgradesApi, ethers, drawTime } = await setup();
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      await factory.createLottery(ethers.parseEther("0.1"), 100n, 5n, drawTime);
      expect(await factory.getLotteryCount()).to.equal(2n);

      const LotteryFactoryV2 = await ethers.getContractFactory("LotteryFactory");
      const upgraded = await upgradesApi.upgradeProxy(
        await factory.getAddress(),
        LotteryFactoryV2,
        { kind: "uups" }
      );
      await upgraded.waitForDeployment();
      expect(await upgraded.getLotteryCount()).to.equal(2n);
      expect(await upgraded.getAddress()).to.equal(await factory.getAddress());
    });

    it("Should revert upgrade from non-admin", async function () {
      const { factory, stranger, DEFAULT_ADMIN_ROLE, ethers, upgradesApi } =
        await setup();
      const LotteryFactoryV2 = await ethers.getContractFactory(
        "LotteryFactory", stranger
      );
      await expect(
        upgradesApi.upgradeProxy(
          await factory.getAddress(),
          LotteryFactoryV2,
          { kind: "uups" }
        )
      )
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, DEFAULT_ADMIN_ROLE);
    });
  });
});
