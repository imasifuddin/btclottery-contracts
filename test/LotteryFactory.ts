import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

describe("LotteryFactory", function () {
  // ─── Shared connection (created once, reused across all tests) ───────────
  let ethers: Awaited<ReturnType<typeof hre.network.create>>["ethers"];
  let upgradesApi: Awaited<ReturnType<typeof upgrades>>;

  before(async function () {
    const connection = await hre.network.create();
    ethers = connection.ethers;
    upgradesApi = await upgrades(hre, connection);
  });

  // ─── Fixture ─────────────────────────────────────────────────────────────

  async function deployLotteryFactoryFixture() {
    const [admin, lotteryCreator, pauser, stranger] =
      await ethers.getSigners();

    const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
    const factory = await upgradesApi.deployProxy(
      LotteryFactory,
      [admin.address],
      { kind: "uups" }
    );
    await factory.waitForDeployment();

    const LOTTERY_CREATOR_ROLE = await factory.LOTTERY_CREATOR_ROLE();
    const PAUSER_ROLE = await factory.PAUSER_ROLE();
    const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();

    return {
      factory,
      admin,
      lotteryCreator,
      pauser,
      stranger,
      LOTTERY_CREATOR_ROLE,
      PAUSER_ROLE,
      DEFAULT_ADMIN_ROLE,
    };
  }

  // ─── Deployment ──────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("Should deploy via UUPS proxy successfully", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      expect(await factory.getAddress()).to.be.properAddress;
    });

    it("Should revert if initialized with zero address admin", async function () {
      const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
      await expect(
        upgradesApi.deployProxy(LotteryFactory, [ZeroAddress], { kind: "uups" })
      ).to.be.revertedWith("LotteryFactory: admin is zero address");
    });

    it("Should grant all three roles to admin on initialize", async function () {
      const { factory, admin, LOTTERY_CREATOR_ROLE, PAUSER_ROLE, DEFAULT_ADMIN_ROLE } =
        await deployLotteryFactoryFixture();

      expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await factory.hasRole(LOTTERY_CREATOR_ROLE, admin.address)).to.be.true;
      expect(await factory.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("Should start with zero lotteries", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      expect(await factory.getLotteryCount()).to.equal(0n);
    });
  });

  // ─── createLottery ───────────────────────────────────────────────────────

  describe("createLottery()", function () {
    it("Should deploy a new Lottery contract and register it", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      await factory.createLottery();
      expect(await factory.getLotteryCount()).to.equal(1n);
      const lotteryAddress = await factory.getLottery(0);
      expect(lotteryAddress).to.be.properAddress;
      expect(lotteryAddress).to.not.equal(ZeroAddress);
    });

    it("Should emit LotteryCreated with correct args", async function () {
      const { factory, admin } = await deployLotteryFactoryFixture();
      const tx = await factory.createLottery();
      const lotteryAddress = await factory.getLottery(0);
      await expect(tx)
        .to.emit(factory, "LotteryCreated")
        .withArgs(0n, lotteryAddress, admin.address);
    });

    it("Should correctly assign sequential IDs across multiple lotteries", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      await factory.createLottery();
      await factory.createLottery();
      await factory.createLottery();

      expect(await factory.getLotteryCount()).to.equal(3n);
      const all = await factory.getAllLotteries();
      expect(all.length).to.equal(3);

      for (let i = 0; i < 3; i++) {
        expect(await factory.getLottery(i)).to.equal(all[i]);
        expect(all[i]).to.be.properAddress;
      }
    });

    it("Should revert when called without LOTTERY_CREATOR_ROLE", async function () {
      const { factory, stranger, LOTTERY_CREATOR_ROLE } =
        await deployLotteryFactoryFixture();

      await expect(
        factory.connect(stranger).createLottery()
      )
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, LOTTERY_CREATOR_ROLE);
    });

    it("Should allow a newly granted LOTTERY_CREATOR_ROLE to create a lottery", async function () {
      const { factory, admin, lotteryCreator, LOTTERY_CREATOR_ROLE } =
        await deployLotteryFactoryFixture();

      await factory.connect(admin).grantRole(LOTTERY_CREATOR_ROLE, lotteryCreator.address);
      await factory.connect(lotteryCreator).createLottery();
      expect(await factory.getLotteryCount()).to.equal(1n);
    });
  });

  // ─── Pause / Unpause ─────────────────────────────────────────────────────

  describe("Pause / Unpause", function () {
    it("Should allow PAUSER_ROLE to pause the contract", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      await factory.pause();
      await expect(factory.createLottery()).to.be.revertedWithCustomError(
        factory,
        "EnforcedPause"
      );
    });

    it("Should allow PAUSER_ROLE to unpause and resume creation", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      await factory.pause();
      await factory.unpause();
      await factory.createLottery();
      expect(await factory.getLotteryCount()).to.equal(1n);
    });

    it("Should revert pause() when called without PAUSER_ROLE", async function () {
      const { factory, stranger, PAUSER_ROLE } =
        await deployLotteryFactoryFixture();

      await expect(factory.connect(stranger).pause())
        .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, PAUSER_ROLE);
    });
  });

  // ─── Upgradeability ──────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", function () {
    it("Should upgrade to a new implementation and preserve state", async function () {
      const { factory } = await deployLotteryFactoryFixture();
      await factory.createLottery();
      await factory.createLottery();
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

    it("Should revert upgrade attempt from non-admin", async function () {
      const { factory, stranger, DEFAULT_ADMIN_ROLE } =
        await deployLotteryFactoryFixture();

      const LotteryFactoryV2 = await ethers.getContractFactory(
        "LotteryFactory",
        stranger
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
