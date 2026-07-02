import { expect } from "chai";
import hre from "hardhat";

describe("TicketNFT", function () {
  async function setup() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const [admin, lotteryCore, user1, user2] = await ethers.getSigners();

    const TicketNFT = await ethers.getContractFactory("TicketNFT");
    const nft = await TicketNFT.deploy(admin.address);
    await nft.waitForDeployment();

    const MINTER_ROLE = await nft.MINTER_ROLE();
    await nft.connect(admin).grantRole(MINTER_ROLE, lotteryCore.address);

    return { ethers, nft, admin, lotteryCore, user1, user2, MINTER_ROLE };
  }

  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      const { nft } = await setup();
      expect(await nft.name()).to.equal("btclottery.io Ticket");
      expect(await nft.symbol()).to.equal("BTCLTKT");
    });

    it("Should start with zero tickets minted", async function () {
      const { nft } = await setup();
      expect(await nft.totalMinted()).to.equal(0n);
    });

    it("Should revert deployment with zero admin address", async function () {
      const { ethers } = await setup();
      const TicketNFT = await ethers.getContractFactory("TicketNFT");
      await expect(
        TicketNFT.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(TicketNFT, "ZeroAddress");
    });
  });

  describe("mintTicket()", function () {
    it("Should mint a ticket and assign correct owner", async function () {
      const { nft, lotteryCore, user1 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 0n, "ipfs://ticket1");
      expect(await nft.ownerOf(0n)).to.equal(user1.address);
      expect(await nft.totalMinted()).to.equal(1n);
    });

    it("Should emit TicketMinted event", async function () {
      const { nft, lotteryCore, user1 } = await setup();
      await expect(
        nft.connect(lotteryCore).mintTicket(user1.address, 5n, "ipfs://ticket1")
      ).to.emit(nft, "TicketMinted")
        .withArgs(0n, 5n, user1.address);
    });

    it("Should store correct lotteryId for a ticket", async function () {
      const { nft, lotteryCore, user1 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 7n, "ipfs://ticket1");
      expect(await nft.ticketLotteryId(0n)).to.equal(7n);
    });

    it("Should store and return correct metadata URI", async function () {
      const { nft, lotteryCore, user1 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 0n, "ipfs://QmTest123");
      expect(await nft.tokenURI(0n)).to.equal("ipfs://QmTest123");
    });

    it("Should increment token IDs sequentially across multiple mints", async function () {
      const { nft, lotteryCore, user1, user2 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 0n, "ipfs://1");
      await nft.connect(lotteryCore).mintTicket(user2.address, 0n, "ipfs://2");
      await nft.connect(lotteryCore).mintTicket(user1.address, 1n, "ipfs://3");

      expect(await nft.ownerOf(0n)).to.equal(user1.address);
      expect(await nft.ownerOf(1n)).to.equal(user2.address);
      expect(await nft.ownerOf(2n)).to.equal(user1.address);
      expect(await nft.totalMinted()).to.equal(3n);
    });

    it("Should revert when called without MINTER_ROLE", async function () {
      const { nft, user1, user2, MINTER_ROLE } = await setup();
      await expect(
        nft.connect(user1).mintTicket(user2.address, 0n, "ipfs://x")
      ).to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, MINTER_ROLE);
    });

    it("Should revert minting to zero address", async function () {
      const { nft, lotteryCore, ethers } = await setup();
      await expect(
        nft.connect(lotteryCore).mintTicket(ethers.ZeroAddress, 0n, "ipfs://x")
      ).to.be.revertedWithCustomError(nft, "ZeroAddress");
    });

    it("Should allow a second authorized address to mint independently", async function () {
      const { nft, admin, user1, user2, MINTER_ROLE } = await setup();
      await nft.connect(admin).grantRole(MINTER_ROLE, user2.address);
      await nft.connect(user2).mintTicket(user1.address, 2n, "ipfs://from-second-lottery");
      expect(await nft.totalMinted()).to.equal(1n);
      expect(await nft.ownerOf(0n)).to.equal(user1.address);
    });
  });

  describe("ERC721Burnable", function () {
    it("Should allow ticket owner to burn their ticket", async function () {
      const { nft, lotteryCore, user1 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 0n, "ipfs://x");
      await nft.connect(user1).burn(0n);

      let reverted = false;
      try {
        await nft.ownerOf(0n);
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });

    it("Should revert burn from non-owner, non-approved address", async function () {
      const { nft, lotteryCore, user1, user2 } = await setup();
      await nft.connect(lotteryCore).mintTicket(user1.address, 0n, "ipfs://x");

      let reverted = false;
      try {
        await nft.connect(user2).burn(0n);
      } catch {
        reverted = true;
      }
      expect(reverted).to.be.true;
    });
  });

  describe("supportsInterface", function () {
    it("Should support ERC721 interface", async function () {
      const { nft } = await setup();
      expect(await nft.supportsInterface("0x80ac58cd")).to.be.true;
    });

    it("Should support AccessControl interface", async function () {
      const { nft } = await setup();
      expect(await nft.supportsInterface("0x7965db0b")).to.be.true;
    });
  });
});
