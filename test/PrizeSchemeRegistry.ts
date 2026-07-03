import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

describe("PrizeSchemeRegistry", function () {
  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);
    const [admin, manager, stranger] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("PrizeSchemeRegistry");
    const registry = await upgradesApi.deployProxy(Registry, [admin.address], { kind: "uups" });
    await registry.waitForDeployment();

    const SCHEME_MANAGER_ROLE = await registry.SCHEME_MANAGER_ROLE();

    return { ethers, upgradesApi, registry, admin, manager, stranger, SCHEME_MANAGER_ROLE };
  }

  describe("Deployment", function () {
    it("Should grant admin and manager roles to deployer-specified admin", async function () {
      const { registry, admin, SCHEME_MANAGER_ROLE } = await setup();
      const DEFAULT_ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
      expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await registry.hasRole(SCHEME_MANAGER_ROLE, admin.address)).to.be.true;
    });

    it("Should start with zero schemes", async function () {
      const { registry } = await setup();
      expect(await registry.schemeCount()).to.equal(0n);
    });

    it("Should revert deployment with zero admin address", async function () {
      const { ethers, upgradesApi } = await setup();
      const Registry = await ethers.getContractFactory("PrizeSchemeRegistry");
      await expect(
        upgradesApi.deployProxy(Registry, [ethers.ZeroAddress], { kind: "uups" })
      ).to.be.revertedWithCustomError(Registry, "InvalidParam");
    });
  });

  describe("createScheme()", function () {
    it("Should create a valid 3-tier scheme", async function () {
      const { registry, admin } = await setup();
      const tx = await registry.connect(admin).createScheme(
        "Standard 3-tier",
        [5000n, 3000n, 1000n], // 50/30/10
        500n,                  // 5% fee
        false
      );
      await expect(tx).to.emit(registry, "SchemeCreated")
        .withArgs(0n, "Standard 3-tier", 3n, false);

      const scheme = await registry.getScheme(0n);
      expect(scheme.name).to.equal("Standard 3-tier");
      expect(scheme.tierBps.length).to.equal(3);
      expect(scheme.feeBps).to.equal(500n);
      expect(scheme.active).to.be.true;
    });

    it("Should create a winner-takes-all scheme", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme(
        "Winner Takes All", [9500n], 500n, false
      );
      const scheme = await registry.getScheme(0n);
      expect(scheme.tierBps.length).to.equal(1);
      expect(scheme.tierBps[0]).to.equal(9500n);
    });

    it("Should create a jackpot scheme", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme(
        "Rolling Jackpot", [9500n], 500n, true
      );
      const scheme = await registry.getScheme(0n);
      expect(scheme.isJackpot).to.be.true;
    });

    it("Should increment schemeCount and assign sequential IDs", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme("A", [9500n], 500n, false);
      await registry.connect(admin).createScheme("B", [5000n, 4500n], 500n, false);
      expect(await registry.schemeCount()).to.equal(2n);
    });

    it("Should revert with empty name", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).createScheme("", [9500n], 500n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert with zero tiers", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).createScheme("Empty", [], 500n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert if tiers exceed MAX_TIERS", async function () {
      const { registry, admin } = await setup();
      const tooMany = new Array(11).fill(100n); // 11 > MAX_TIERS (10)
      await expect(
        registry.connect(admin).createScheme("TooMany", tooMany, 500n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert if feeBps exceeds 10%", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).createScheme("HighFee", [9000n], 1001n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert if total bps (fee + tiers) exceeds 100%", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).createScheme("Overflow", [9800n], 500n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert if any tier bps is zero", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).createScheme("ZeroTier", [5000n, 0n], 500n, false)
      ).to.be.revertedWithCustomError(registry, "InvalidParam");
    });

    it("Should revert when called without SCHEME_MANAGER_ROLE", async function () {
      const { registry, stranger, SCHEME_MANAGER_ROLE } = await setup();
      await expect(
        registry.connect(stranger).createScheme("X", [9500n], 500n, false)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, SCHEME_MANAGER_ROLE);
    });
  });

  describe("deactivateScheme()", function () {
    it("Should deactivate an active scheme", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme("A", [9500n], 500n, false);
      await registry.connect(admin).deactivateScheme(0n);
      expect(await registry.isSchemeActive(0n)).to.be.false;
    });

    it("Should emit SchemeDeactivated event", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme("A", [9500n], 500n, false);
      await expect(registry.connect(admin).deactivateScheme(0n))
        .to.emit(registry, "SchemeDeactivated")
        .withArgs(0n);
    });

    it("Should revert deactivating a non-existent scheme", async function () {
      const { registry, admin } = await setup();
      await expect(
        registry.connect(admin).deactivateScheme(99n)
      ).to.be.revertedWithCustomError(registry, "SchemeNotFound");
    });

    it("Should revert when called without SCHEME_MANAGER_ROLE", async function () {
      const { registry, admin, stranger, SCHEME_MANAGER_ROLE } = await setup();
      await registry.connect(admin).createScheme("A", [9500n], 500n, false);
      await expect(
        registry.connect(stranger).deactivateScheme(0n)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, SCHEME_MANAGER_ROLE);
    });
  });

  describe("Views", function () {
    it("Should revert getScheme for non-existent scheme", async function () {
      const { registry } = await setup();
      await expect(registry.getScheme(0n)).to.be.revertedWithCustomError(registry, "SchemeNotFound");
    });

    it("Should return correct tier count", async function () {
      const { registry, admin } = await setup();
      await registry.connect(admin).createScheme("A", [5000n, 3000n, 1500n], 500n, false);
      expect(await registry.getTierCount(0n)).to.equal(3n);
    });
  });
});
