import { expect } from "chai";
import hre from "hardhat";

describe("BTCLPToken", function () {
  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const [admin, minter, user1, user2] = await ethers.getSigners();

    const BTCLPToken = await ethers.getContractFactory("BTCLPToken");
    const token = await BTCLPToken.deploy(admin.address);
    await token.waitForDeployment();

    const MINTER_ROLE = await token.MINTER_ROLE();
    const MAX_SUPPLY = await token.MAX_SUPPLY();

    return { ethers, token, admin, minter, user1, user2, MINTER_ROLE, MAX_SUPPLY };
  }

  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      const { token } = await setup();
      expect(await token.name()).to.equal("BTC Lottery Token");
      expect(await token.symbol()).to.equal("BTCLP");
    });

    it("Should grant admin and minter roles to deployer-specified admin", async function () {
      const { token, admin } = await setup();
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      const MINTER_ROLE = await token.MINTER_ROLE();
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await token.hasRole(MINTER_ROLE, admin.address)).to.be.true;
    });

    it("Should start with zero total supply", async function () {
      const { token } = await setup();
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("Should revert deployment with zero admin address", async function () {
      const { ethers } = await setup();
      const BTCLPToken = await ethers.getContractFactory("BTCLPToken");
      await expect(
        BTCLPToken.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(BTCLPToken, "ZeroAddress");
    });
  });

  describe("mint()", function () {
    it("Should mint tokens up to MAX_SUPPLY", async function () {
      const { token, admin, user1 } = await setup();
      await token.connect(admin).mint(user1.address, 1000n);
      expect(await token.balanceOf(user1.address)).to.equal(1000n);
      expect(await token.totalSupply()).to.equal(1000n);
    });

    it("Should revert if minting would exceed MAX_SUPPLY", async function () {
      const { token, admin, user1, MAX_SUPPLY } = await setup();
      await expect(
        token.connect(admin).mint(user1.address, MAX_SUPPLY + 1n)
      ).to.be.revertedWithCustomError(token, "ExceedsMaxSupply");
    });

    it("Should allow minting exactly up to MAX_SUPPLY", async function () {
      const { token, admin, user1, MAX_SUPPLY } = await setup();
      await token.connect(admin).mint(user1.address, MAX_SUPPLY);
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("Should revert when called by non-minter", async function () {
      const { token, user1, user2, MINTER_ROLE } = await setup();
      await expect(
        token.connect(user1).mint(user2.address, 1000n)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, MINTER_ROLE);
    });

    it("Should allow granting MINTER_ROLE to a new address", async function () {
      const { token, admin, minter, user1, MINTER_ROLE } = await setup();
      await token.connect(admin).grantRole(MINTER_ROLE, minter.address);
      await token.connect(minter).mint(user1.address, 500n);
      expect(await token.balanceOf(user1.address)).to.equal(500n);
    });
  });

  describe("ERC20Burnable", function () {
    it("Should allow token holder to burn their own tokens", async function () {
      const { token, admin, user1 } = await setup();
      await token.connect(admin).mint(user1.address, 1000n);
      await token.connect(user1).burn(400n);
      expect(await token.balanceOf(user1.address)).to.equal(600n);
      expect(await token.totalSupply()).to.equal(600n);
    });
  });

  describe("ERC20Votes (governance)", function () {
    it("Should have zero voting power before delegation", async function () {
      const { token, admin, user1 } = await setup();
      await token.connect(admin).mint(user1.address, 1000n);
      expect(await token.getVotes(user1.address)).to.equal(0n);
    });

    it("Should grant voting power after self-delegation", async function () {
      const { token, admin, user1 } = await setup();
      await token.connect(admin).mint(user1.address, 1000n);
      await token.connect(user1).delegate(user1.address);
      expect(await token.getVotes(user1.address)).to.equal(1000n);
    });

    it("Should transfer voting power when delegating to another address", async function () {
      const { token, admin, user1, user2 } = await setup();
      await token.connect(admin).mint(user1.address, 1000n);
      await token.connect(user1).delegate(user2.address);
      expect(await token.getVotes(user2.address)).to.equal(1000n);
      expect(await token.getVotes(user1.address)).to.equal(0n);
    });
  });

  describe("ERC20Permit (gasless approval)", function () {
    it("Should have correct EIP-712 domain name", async function () {
      const { token } = await setup();
      const domain = await token.eip712Domain();
      expect(domain.name).to.equal("BTC Lottery Token");
    });

    it("Should start with nonce 0 for a fresh address", async function () {
      const { token, user1 } = await setup();
      expect(await token.nonces(user1.address)).to.equal(0n);
    });
  });
});
