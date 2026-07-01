import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

describe("LotteryCore", function () {

  async function setup(overrides: {
    ticketPrice?: bigint;
    maxTickets?: bigint;
    minTickets?: bigint;
    drawTimeOffset?: number;
    feeBps?: bigint;
  } = {}) {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);

    const [admin, buyer1, buyer2, buyer3, feeRecipient] =
      await ethers.getSigners();

    const ticketPrice = overrides.ticketPrice ?? ethers.parseEther("0.1");
    const maxTickets = overrides.maxTickets ?? 100n;
    const minTickets = overrides.minTickets ?? 5n;
    const drawTimeOffset = overrides.drawTimeOffset ?? 3600;
    const feeBps = overrides.feeBps ?? 500n;

    const block = await ethers.provider.getBlock("latest");
    const drawTime = BigInt(block!.timestamp + drawTimeOffset);

    const LotteryCore = await ethers.getContractFactory("LotteryCore");
    const lottery = await LotteryCore.deploy(
      admin.address, 0n, admin.address,
      ticketPrice, maxTickets, minTickets,
      drawTime, feeBps, feeRecipient.address
    );
    await lottery.waitForDeployment();

    return {
      ethers, upgradesApi, lottery, LotteryCore,
      admin, buyer1, buyer2, buyer3, feeRecipient,
      ticketPrice, maxTickets, minTickets, drawTime, feeBps,
    };
  }

  // ─── Deployment ──────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("Should deploy with correct initial state", async function () {
      const { lottery, ticketPrice, maxTickets, minTickets, drawTime, feeBps } =
        await setup();
      expect(await lottery.status()).to.equal(1n);
      expect(await lottery.ticketPrice()).to.equal(ticketPrice);
      expect(await lottery.maxTickets()).to.equal(maxTickets);
      expect(await lottery.minTickets()).to.equal(minTickets);
      expect(await lottery.drawTime()).to.equal(drawTime);
      expect(await lottery.feeBps()).to.equal(feeBps);
      expect(await lottery.ticketsSold()).to.equal(0n);
      expect(await lottery.prizePool()).to.equal(0n);
      expect(await lottery.winner()).to.equal(ZeroAddress);
    });

    it("Should revert with zero factory address", async function () {
      const { LotteryCore, admin, feeRecipient, drawTime, ethers } = await setup();
      await expect(
        LotteryCore.deploy(
          ZeroAddress, 0n, admin.address,
          ethers.parseEther("0.1"), 100n, 5n, drawTime, 500n, feeRecipient.address
        )
      ).to.be.revertedWithCustomError(LotteryCore, "ZeroAddress");
    });

    it("Should revert if drawTime is in the past", async function () {
      const { LotteryCore, admin, feeRecipient, ethers } = await setup();
      const block = await ethers.provider.getBlock("latest");
      const pastTime = BigInt(block!.timestamp - 1);
      await expect(
        LotteryCore.deploy(
          admin.address, 0n, admin.address,
          ethers.parseEther("0.1"), 100n, 5n, pastTime, 500n, feeRecipient.address
        )
      ).to.be.revertedWithCustomError(LotteryCore, "InvalidParam");
    });

    it("Should revert if minTickets > maxTickets", async function () {
      const { LotteryCore, admin, feeRecipient, drawTime, ethers } = await setup();
      await expect(
        LotteryCore.deploy(
          admin.address, 0n, admin.address,
          ethers.parseEther("0.1"), 5n, 100n, drawTime, 500n, feeRecipient.address
        )
      ).to.be.revertedWithCustomError(LotteryCore, "InvalidParam");
    });

    it("Should revert if feeBps > 1000", async function () {
      const { LotteryCore, admin, feeRecipient, drawTime, ethers } = await setup();
      await expect(
        LotteryCore.deploy(
          admin.address, 0n, admin.address,
          ethers.parseEther("0.1"), 100n, 5n, drawTime, 1001n, feeRecipient.address
        )
      ).to.be.revertedWithCustomError(LotteryCore, "InvalidParam");
    });
  });

  // ─── buyTickets ──────────────────────────────────────────────────────────

  describe("buyTickets()", function () {
    it("Should allow buying tickets with correct payment", async function () {
      const { lottery, buyer1, ticketPrice } = await setup();
      await lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice * 2n });
      expect(await lottery.ticketsSold()).to.equal(2n);
      expect(await lottery.prizePool()).to.equal(ticketPrice * 2n);
      expect(await lottery.ticketsBought(buyer1.address)).to.equal(2n);
    });

    it("Should emit TicketsPurchased event", async function () {
      const { lottery, buyer1, ticketPrice } = await setup();
      await expect(
        lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice })
      ).to.emit(lottery, "TicketsPurchased")
        .withArgs(0n, buyer1.address, 1n, ticketPrice);
    });

    it("Should revert with incorrect payment", async function () {
      const { lottery, buyer1, ticketPrice } = await setup();
      await expect(
        lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice })
      ).to.be.revertedWithCustomError(lottery, "IncorrectPayment");
    });

    it("Should revert if count is zero", async function () {
      const { lottery, buyer1 } = await setup();
      await expect(
        lottery.connect(buyer1).buyTickets(0n, { value: 0n })
      ).to.be.revertedWithCustomError(lottery, "InvalidParam");
    });

    it("Should revert if tickets exceed maxTickets", async function () {
      const { lottery, buyer1, ticketPrice } =
        await setup({ maxTickets: 3n, minTickets: 1n });
      await expect(
        lottery.connect(buyer1).buyTickets(4n, { value: ticketPrice * 4n })
      ).to.be.revertedWithCustomError(lottery, "SoldOut");
    });

    it("Should track multiple buyers correctly", async function () {
      const { lottery, buyer1, buyer2, ticketPrice } = await setup();
      await lottery.connect(buyer1).buyTickets(3n, { value: ticketPrice * 3n });
      await lottery.connect(buyer2).buyTickets(2n, { value: ticketPrice * 2n });
      expect(await lottery.ticketsSold()).to.equal(5n);
      expect(await lottery.getBuyerCount()).to.equal(2n);
    });

    it("Should revert if draw time has passed", async function () {
      const { lottery, buyer1, ticketPrice, ethers } =
        await setup({ drawTimeOffset: 2 });
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice })
      ).to.be.revertedWithCustomError(lottery, "DrawTimeAlreadyPassed");
    });

    it("Should revert when paused", async function () {
      const { lottery, admin, buyer1, ticketPrice } = await setup();
      await lottery.connect(admin).pause();
      await expect(
        lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice })
      ).to.be.revertedWithCustomError(lottery, "EnforcedPause");
    });
  });

  // ─── requestDraw + fulfillRandomWords ────────────────────────────────────

  describe("requestDraw() + fulfillRandomWords()", function () {
    async function setupWithMinTicketsSold() {
      const ctx = await setup({ minTickets: 3n, drawTimeOffset: 60 });
      const { lottery, buyer1, buyer2, buyer3, ticketPrice, ethers } = ctx;
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      return ctx;
    }

    it("Should move to Drawing status after requestDraw", async function () {
      const { lottery, admin } = await setupWithMinTicketsSold();
      await lottery.connect(admin).requestDraw();
      expect(await lottery.status()).to.equal(2n);
    });

    it("Should emit DrawRequested event", async function () {
      const { lottery, admin } = await setupWithMinTicketsSold();
      await expect(lottery.connect(admin).requestDraw())
        .to.emit(lottery, "DrawRequested")
        .withArgs(0n, 3n);
    });

    it("Should revert requestDraw if drawTime not reached", async function () {
      const { lottery, admin, buyer1, ticketPrice } =
        await setup({ minTickets: 1n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await expect(
        lottery.connect(admin).requestDraw()
      ).to.be.revertedWithCustomError(lottery, "DrawTimeNotReached");
    });

    it("Should revert requestDraw if minTickets not met", async function () {
      const { lottery, admin, buyer1, ticketPrice, ethers } =
        await setup({ minTickets: 5n, drawTimeOffset: 60 });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        lottery.connect(admin).requestDraw()
      ).to.be.revertedWithCustomError(lottery, "MinTicketsNotMet");
    });

    it("Should select a valid winner via fulfillRandomWords", async function () {
      const { lottery, admin, buyer1, buyer2, buyer3 } =
        await setupWithMinTicketsSold();
      await lottery.connect(admin).requestDraw();
      await lottery.connect(admin).fulfillRandomWords(12345n);
      expect(await lottery.status()).to.equal(3n);
      const w = await lottery.winner();
      expect([buyer1.address, buyer2.address, buyer3.address]).to.include(w);
    });

    it("Should emit WinnerSelected event", async function () {
      const { lottery, admin } = await setupWithMinTicketsSold();
      await lottery.connect(admin).requestDraw();
      await expect(lottery.connect(admin).fulfillRandomWords(99n))
        .to.emit(lottery, "WinnerSelected");
    });
  });

  // ─── claimPrize ──────────────────────────────────────────────────────────

  describe("claimPrize()", function () {
    async function setupCompleted() {
      const ctx = await setup({ minTickets: 1n, drawTimeOffset: 60, feeBps: 500n });
      const { lottery, admin, buyer1, ticketPrice, ethers } = ctx;
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await lottery.connect(admin).requestDraw();
      await lottery.connect(admin).fulfillRandomWords(0n);
      return ctx;
    }

    it("Should pay winner the correct prize after fee", async function () {
      const { lottery, buyer1, ticketPrice, ethers } = await setupCompleted();
      const prize = ticketPrice - (ticketPrice * 500n / 10000n);
      const before = await ethers.provider.getBalance(buyer1.address);
      const tx = await lottery.connect(buyer1).claimPrize();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(buyer1.address);
      expect(after - before + gasUsed).to.equal(prize);
    });

    it("Should emit PrizeClaimed event", async function () {
      const { lottery, buyer1 } = await setupCompleted();
      await expect(lottery.connect(buyer1).claimPrize())
        .to.emit(lottery, "PrizeClaimed");
    });

    it("Should revert if non-winner tries to claim", async function () {
      const { lottery, buyer2 } = await setupCompleted();
      await expect(
        lottery.connect(buyer2).claimPrize()
      ).to.be.revertedWithCustomError(lottery, "NotWinner");
    });

    it("Should revert on double claim", async function () {
      const { lottery, buyer1 } = await setupCompleted();
      await lottery.connect(buyer1).claimPrize();
      await expect(
        lottery.connect(buyer1).claimPrize()
      ).to.be.revertedWithCustomError(lottery, "AlreadyClaimed");
    });
  });

  // ─── Refunds ─────────────────────────────────────────────────────────────

  describe("triggerRefund() + claimRefund()", function () {
    async function setupExpiredNoMinTickets() {
      const ctx = await setup({ minTickets: 5n, drawTimeOffset: 60 });
      const { lottery, buyer1, buyer2, ticketPrice, ethers } = ctx;
      await lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice * 2n });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      return ctx;
    }

    it("Should move to Refunding status after triggerRefund", async function () {
      const { lottery, admin } = await setupExpiredNoMinTickets();
      await lottery.connect(admin).triggerRefund();
      expect(await lottery.status()).to.equal(4n);
    });

    it("Should emit RefundTriggered event", async function () {
      const { lottery, admin } = await setupExpiredNoMinTickets();
      await expect(lottery.connect(admin).triggerRefund())
        .to.emit(lottery, "RefundTriggered")
        .withArgs(0n, 3n);
    });

    it("Should revert triggerRefund if minTickets were met", async function () {
      const { lottery, admin, buyer1, ticketPrice, ethers } =
        await setup({ minTickets: 1n, drawTimeOffset: 60 });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        lottery.connect(admin).triggerRefund()
      ).to.be.revertedWithCustomError(lottery, "MinTicketsMet");
    });

    it("Should refund buyers the correct amount", async function () {
      const { lottery, admin, buyer1, ticketPrice, ethers } =
        await setupExpiredNoMinTickets();
      await lottery.connect(admin).triggerRefund();
      const refundAmount = ticketPrice * 2n;
      const before = await ethers.provider.getBalance(buyer1.address);
      const tx = await lottery.connect(buyer1).claimRefund();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(buyer1.address);
      expect(after - before + gasUsed).to.equal(refundAmount);
    });

    it("Should emit RefundClaimed event", async function () {
      const { lottery, admin, buyer1, ticketPrice } =
        await setupExpiredNoMinTickets();
      await lottery.connect(admin).triggerRefund();
      await expect(lottery.connect(buyer1).claimRefund())
        .to.emit(lottery, "RefundClaimed")
        .withArgs(0n, buyer1.address, ticketPrice * 2n);
    });

    it("Should revert claimRefund for non-buyer", async function () {
      const { lottery, admin, buyer3 } = await setupExpiredNoMinTickets();
      await lottery.connect(admin).triggerRefund();
      await expect(
        lottery.connect(buyer3).claimRefund()
      ).to.be.revertedWithCustomError(lottery, "NoTicketsPurchased");
    });

    it("Should revert on double refund claim", async function () {
      const { lottery, admin, buyer1 } = await setupExpiredNoMinTickets();
      await lottery.connect(admin).triggerRefund();
      await lottery.connect(buyer1).claimRefund();
      await expect(
        lottery.connect(buyer1).claimRefund()
      ).to.be.revertedWithCustomError(lottery, "AlreadyClaimed");
    });
  });

  // ─── LotteryFactory integration ──────────────────────────────────────────

  describe("LotteryFactory integration", function () {
    it("Should deploy LotteryCore via factory and be functional", async function () {
      const connection = await hre.network.create();
      const { ethers } = connection;
      const upgradesApi = await upgrades(hre, connection);
      const [admin, , , , feeRecipient] = await ethers.getSigners();

      const LotteryFactory = await ethers.getContractFactory("LotteryFactory");
      const factory = await upgradesApi.deployProxy(
        LotteryFactory,
        [admin.address, 500n, feeRecipient.address],
        { kind: "uups" }
      );
      await factory.waitForDeployment();

      const block = await ethers.provider.getBlock("latest");
      const drawTime = BigInt(block!.timestamp + 3600);

      await factory.createLottery(
        ethers.parseEther("0.1"), 100n, 5n, drawTime
      );

      expect(await factory.getLotteryCount()).to.equal(1n);
      const lotteryAddr = await factory.getLottery(0n);
      const LotteryCore = await ethers.getContractFactory("LotteryCore");
      const lottery = LotteryCore.attach(lotteryAddr);
      expect(await lottery.status()).to.equal(1n);
      expect(await lottery.ticketPrice()).to.equal(ethers.parseEther("0.1"));
    });
  });
});
