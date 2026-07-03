import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
const CALLBACK_GAS_LIMIT = 500_000; // higher: multi-winner loop costs more gas
const REQUEST_CONFIRMATIONS = 3;
const BASE_FEE = "100000000000000000";
const GAS_PRICE_LINK = "1000000000";

describe("LotteryCore", function () {

  async function setup(overrides: {
    ticketPrice?: bigint;
    maxTickets?: bigint;
    minTickets?: bigint;
    drawTimeOffset?: number;
    tierBps?: bigint[];
    feeBps?: bigint;
    isJackpot?: boolean;
  } = {}) {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);

    const [admin, buyer1, buyer2, buyer3, buyer4, feeRecipient] =
      await ethers.getSigners();

    // Deploy mock VRF coordinator
    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const mockCoordinator = await MockCoordinator.deploy(BASE_FEE, GAS_PRICE_LINK, "4000000000000000");
    await mockCoordinator.waitForDeployment();

    const createSubTx = await mockCoordinator.createSubscription();
    const receipt = await createSubTx.wait();
    const subLog = receipt!.logs.find((l: any) => l.fragment?.name === "SubscriptionCreated") as any;
    const subscriptionId: bigint = subLog.args[0];
    await mockCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    // Deploy prize scheme registry + create a scheme
    const Registry = await ethers.getContractFactory("PrizeSchemeRegistry");
    const registry = await upgradesApi.deployProxy(Registry, [admin.address], { kind: "uups" });
    await registry.waitForDeployment();

    const tierBps  = overrides.tierBps  ?? [5000n, 3000n, 1000n]; // 3-tier default
    const feeBps    = overrides.feeBps  ?? 500n;
    const isJackpot = overrides.isJackpot ?? false;

    await registry.connect(admin).createScheme("Test Scheme", tierBps, feeBps, isJackpot);
    const schemeId = 0n;

    const ticketPrice    = overrides.ticketPrice    ?? ethers.parseEther("0.1");
    const maxTickets     = overrides.maxTickets     ?? 100n;
    const minTickets     = overrides.minTickets     ?? 5n;
    const drawTimeOffset = overrides.drawTimeOffset ?? 3600;

    const block    = await ethers.provider.getBlock("latest");
    const drawTime = BigInt(block!.timestamp + drawTimeOffset);

    const LotteryCore = await ethers.getContractFactory("LotteryCore");
    const lottery = await LotteryCore.deploy(
      {
        vrfCoordinator:       await mockCoordinator.getAddress(),
        subscriptionId:       subscriptionId,
        keyHash:              KEY_HASH,
        callbackGasLimit:     CALLBACK_GAS_LIMIT,
        requestConfirmations: REQUEST_CONFIRMATIONS,
      },
      {
        factory:              admin.address,
        lotteryId:            0n,
        admin:                admin.address,
        ticketPrice:          ticketPrice,
        maxTickets:           maxTickets,
        minTickets:           minTickets,
        drawTime:             drawTime,
        feeRecipient:         feeRecipient.address,
        prizeSchemeRegistry:  await registry.getAddress(),
        schemeId:             schemeId,
      }
    );
    await lottery.waitForDeployment();

    await mockCoordinator.addConsumer(subscriptionId, await lottery.getAddress());

    return {
      ethers, lottery, LotteryCore, mockCoordinator, subscriptionId,
      registry, schemeId, tierBps, feeBps,
      admin, buyer1, buyer2, buyer3, buyer4, feeRecipient,
      ticketPrice, maxTickets, minTickets, drawTime,
    };
  }

  // ─── Deployment ──────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("Should deploy with correct initial state and tierCount", async function () {
      const { lottery, ticketPrice, maxTickets, minTickets, drawTime } = await setup();
      expect(await lottery.status()).to.equal(1n);
      expect(await lottery.ticketPrice()).to.equal(ticketPrice);
      expect(await lottery.maxTickets()).to.equal(maxTickets);
      expect(await lottery.minTickets()).to.equal(minTickets);
      expect(await lottery.drawTime()).to.equal(drawTime);
      expect(await lottery.tierCount()).to.equal(3n);
      expect(await lottery.ticketsSold()).to.equal(0n);
      expect(await lottery.prizePool()).to.equal(0n);
    });

    it("Should revert if prize scheme is inactive at creation", async function () {
      const { ethers, LotteryCore, mockCoordinator, subscriptionId, registry, admin, feeRecipient, drawTime } =
        await setup();
      await registry.connect(admin).deactivateScheme(0n);

      await expect(
        LotteryCore.deploy(
          {
            vrfCoordinator: await mockCoordinator.getAddress(),
            subscriptionId, keyHash: KEY_HASH,
            callbackGasLimit: CALLBACK_GAS_LIMIT, requestConfirmations: REQUEST_CONFIRMATIONS,
          },
          {
            factory: admin.address, lotteryId: 1n, admin: admin.address,
            ticketPrice: ethers.parseEther("0.1"), maxTickets: 100n, minTickets: 5n,
            drawTime, feeRecipient: feeRecipient.address,
            prizeSchemeRegistry: await registry.getAddress(), schemeId: 0n,
          }
        )
      ).to.be.revertedWithCustomError(LotteryCore, "SchemeInactiveAtCreation");
    });
  });

  // ─── buyTickets ──────────────────────────────────────────────────────────

  describe("buyTickets()", function () {
    it("Should allow buying tickets with correct payment", async function () {
      const { lottery, buyer1, ticketPrice } = await setup();
      await lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice * 2n });
      expect(await lottery.ticketsSold()).to.equal(2n);
      expect(await lottery.prizePool()).to.equal(ticketPrice * 2n);
    });

    it("Should revert with incorrect payment", async function () {
      const { lottery, buyer1, ticketPrice } = await setup();
      await expect(
        lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice })
      ).to.be.revertedWithCustomError(lottery, "IncorrectPayment");
    });
  });

  // ─── requestDraw + multi-winner VRF fulfillment ──────────────────────────

  describe("requestDraw() + multi-winner VRF fulfillment", function () {
    async function setupWithFourBuyersThreeTiers() {
      const ctx = await setup({
        minTickets: 4n,
        drawTimeOffset: 60,
        tierBps: [5000n, 3000n, 1000n], // 3 tiers
      });
      const { lottery, buyer1, buyer2, buyer3, buyer4, ticketPrice, ethers } = ctx;
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer4).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      return ctx;
    }

    it("Should select 3 distinct winners for a 3-tier scheme", async function () {
      const { lottery, admin, mockCoordinator, buyer1, buyer2, buyer3, buyer4 } =
        await setupWithFourBuyersThreeTiers();

      await lottery.connect(admin).requestDraw();
      const requestId = await lottery.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      expect(await lottery.status()).to.equal(3n); // Completed

      const rank0 = await lottery.winners(0n);
      const rank1 = await lottery.winners(1n);
      const rank2 = await lottery.winners(2n);

      const allBuyers = [buyer1.address, buyer2.address, buyer3.address, buyer4.address];
      expect(allBuyers).to.include(rank0);
      expect(allBuyers).to.include(rank1);
      expect(allBuyers).to.include(rank2);

      // No two ranks share the same winner
      expect(rank0).to.not.equal(rank1);
      expect(rank1).to.not.equal(rank2);
      expect(rank0).to.not.equal(rank2);
    });

    it("Should emit WinnerSelected for each rank", async function () {
      const { lottery, admin, mockCoordinator } = await setupWithFourBuyersThreeTiers();
      await lottery.connect(admin).requestDraw();
      const requestId = await lottery.s_requestId();

      const tx = await mockCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());
      const receipt = await tx.wait();

      const events = receipt!.logs.filter((l: any) => {
        try {
          const parsed = lottery.interface.parseLog(l);
          return parsed?.name === "WinnerSelected";
        } catch { return false; }
      });
      expect(events.length).to.equal(3);
    });

    it("Should request numWords equal to tierCount", async function () {
      const { lottery, admin } = await setupWithFourBuyersThreeTiers();
      const tx = await lottery.connect(admin).requestDraw();
      await expect(tx).to.emit(lottery, "DrawRequested");
      expect(await lottery.tierCount()).to.equal(3n);
    });

    it("Should cap ranksToDraw at buyerCount if fewer buyers than tiers", async function () {
      const ctx = await setup({
        minTickets: 2n,
        drawTimeOffset: 60,
        tierBps: [5000n, 3000n, 1000n], // 3 tiers but only 2 buyers
      });
      const { lottery, admin, buyer1, buyer2, ticketPrice, ethers, mockCoordinator } = ctx;
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await lottery.connect(admin).requestDraw();
      const requestId = await lottery.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      const rank0 = await lottery.winners(0n);
      const rank1 = await lottery.winners(1n);
      const rank2 = await lottery.winners(2n); // should remain unset (zero address)

      expect([buyer1.address, buyer2.address]).to.include(rank0);
      expect([buyer1.address, buyer2.address]).to.include(rank1);
      expect(rank2).to.equal(ZeroAddress);
    });
  });

  // ─── claimPrize (per rank) ───────────────────────────────────────────────

  describe("claimPrize(rank)", function () {
    async function setupCompleted() {
      const ctx = await setup({
        minTickets: 3n, drawTimeOffset: 60,
        tierBps: [5000n, 3000n, 1000n], feeBps: 500n,
      });
      const { lottery, admin, buyer1, buyer2, buyer3, ticketPrice, ethers, mockCoordinator } = ctx;
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await lottery.connect(admin).requestDraw();
      const requestId = await lottery.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());
      return ctx;
    }

    it("Should pay rank 0 winner 50% minus fee", async function () {
      const { lottery, ticketPrice, ethers } = await setupCompleted();
      const totalPool = ticketPrice * 3n;
      const expectedPrize = (totalPool * 5000n) / 10000n;

      const rank0Winner = await lottery.winners(0n);
      const winnerSigner = await ethers.getSigner(rank0Winner);

      const before = await ethers.provider.getBalance(rank0Winner);
      const tx = await lottery.connect(winnerSigner).claimPrize(0n);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(rank0Winner);

      expect(after - before + gasUsed).to.equal(expectedPrize);
    });

    it("Should revert if wrong address claims a rank", async function () {
      const { lottery, buyer1, buyer2, buyer3 } = await setupCompleted();
      const rank0 = await lottery.winners(0n);
      const nonWinner = [buyer1, buyer2, buyer3].find(b => b.address !== rank0)!;

      await expect(
        lottery.connect(nonWinner).claimPrize(0n)
      ).to.be.revertedWithCustomError(lottery, "NotWinner");
    });

    it("Should revert on double claim for same rank", async function () {
      const { lottery, ethers } = await setupCompleted();
      const rank0Winner = await lottery.winners(0n);
      const winnerSigner = await ethers.getSigner(rank0Winner);

      await lottery.connect(winnerSigner).claimPrize(0n);
      await expect(
        lottery.connect(winnerSigner).claimPrize(0n)
      ).to.be.revertedWithCustomError(lottery, "AlreadyClaimed");
    });

    it("Should revert claiming an invalid rank", async function () {
      const { lottery, ethers } = await setupCompleted();
      const rank0Winner = await lottery.winners(0n);
      const winnerSigner = await ethers.getSigner(rank0Winner);

      await expect(
        lottery.connect(winnerSigner).claimPrize(99n)
      ).to.be.revertedWithCustomError(lottery, "InvalidRank");
    });

    it("Should allow different ranks to be claimed independently", async function () {
      const { lottery, ethers } = await setupCompleted();
      const rank0Winner = await lottery.winners(0n);
      const rank1Winner = await lottery.winners(1n);

      const signer0 = await ethers.getSigner(rank0Winner);
      const signer1 = await ethers.getSigner(rank1Winner);

      await lottery.connect(signer0).claimPrize(0n);
      await lottery.connect(signer1).claimPrize(1n);

      expect(await lottery.rankClaimed(0n)).to.be.true;
      expect(await lottery.rankClaimed(1n)).to.be.true;
    });
  });

  // ─── Refunds (unchanged behavior, quick smoke test) ──────────────────────

  describe("triggerRefund() + claimRefund()", function () {
    it("Should refund correctly when minTickets not met", async function () {
      const ctx = await setup({ minTickets: 5n, drawTimeOffset: 60 });
      const { lottery, admin, buyer1, ticketPrice, ethers } = ctx;
      await lottery.connect(buyer1).buyTickets(2n, { value: ticketPrice * 2n });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await lottery.connect(admin).triggerRefund();
      expect(await lottery.status()).to.equal(4n);

      const before = await ethers.provider.getBalance(buyer1.address);
      const tx = await lottery.connect(buyer1).claimRefund();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(buyer1.address);

      expect(after - before + gasUsed).to.equal(ticketPrice * 2n);
    });
  });
});

// ─── Chainlink Automation ──────────────────────────────────────────────────

describe("LotteryCore — Chainlink Automation", function () {
  const KEY_HASH_LOCAL = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
  const CALLBACK_GAS_LIMIT_LOCAL = 500_000;
  const REQUEST_CONFIRMATIONS_LOCAL = 3;
  const BASE_FEE_LOCAL = "100000000000000000";
  const GAS_PRICE_LINK_LOCAL = "1000000000";

  async function setupAutomation(overrides: {
    minTickets?: bigint;
    drawTimeOffset?: number;
  } = {}) {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);

    const [admin, forwarder, buyer1, buyer2, buyer3, feeRecipient, stranger] =
      await ethers.getSigners();

    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const mockCoordinator = await MockCoordinator.deploy(BASE_FEE_LOCAL, GAS_PRICE_LINK_LOCAL, "4000000000000000");
    await mockCoordinator.waitForDeployment();

    const createSubTx = await mockCoordinator.createSubscription();
    const receipt = await createSubTx.wait();
    const subLog = receipt!.logs.find((l: any) => l.fragment?.name === "SubscriptionCreated") as any;
    const subscriptionId: bigint = subLog.args[0];
    await mockCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    const Registry = await ethers.getContractFactory("PrizeSchemeRegistry");
    const registry = await upgradesApi.deployProxy(Registry, [admin.address], { kind: "uups" });
    await registry.waitForDeployment();
    await registry.connect(admin).createScheme("Test", [9500n], 500n, false);

    const ticketPrice    = ethers.parseEther("0.1");
    const maxTickets     = 100n;
    const minTickets     = overrides.minTickets ?? 3n;
    const drawTimeOffset = overrides.drawTimeOffset ?? 60;

    const block    = await ethers.provider.getBlock("latest");
    const drawTime = BigInt(block!.timestamp + drawTimeOffset);

    const LotteryCore = await ethers.getContractFactory("LotteryCore");
    const lottery = await LotteryCore.deploy(
      {
        vrfCoordinator: await mockCoordinator.getAddress(),
        subscriptionId, keyHash: KEY_HASH_LOCAL,
        callbackGasLimit: CALLBACK_GAS_LIMIT_LOCAL,
        requestConfirmations: REQUEST_CONFIRMATIONS_LOCAL,
      },
      {
        factory: admin.address, lotteryId: 0n, admin: admin.address,
        ticketPrice, maxTickets, minTickets, drawTime,
        feeRecipient: feeRecipient.address,
        prizeSchemeRegistry: await registry.getAddress(), schemeId: 0n,
      }
    );
    await lottery.waitForDeployment();
    await mockCoordinator.addConsumer(subscriptionId, await lottery.getAddress());

    return {
      ethers, lottery, mockCoordinator, admin, forwarder,
      buyer1, buyer2, buyer3, stranger, ticketPrice, minTickets, drawTime,
    };
  }

  describe("checkUpkeep()", function () {
    it("Should return false before drawTime", async function () {
      const { lottery } = await setupAutomation();
      const [upkeepNeeded] = await lottery.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.false;
    });

    it("Should return true with draw signal when minTickets met after drawTime", async function () {
      const { lottery, buyer1, buyer2, buyer3, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 3n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [upkeepNeeded, performData] = await lottery.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
      const shouldDraw = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], performData)[0];
      expect(shouldDraw).to.be.true;
    });

    it("Should return true with refund signal when minTickets not met after drawTime", async function () {
      const { lottery, buyer1, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 5n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [upkeepNeeded, performData] = await lottery.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
      const shouldDraw = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], performData)[0];
      expect(shouldDraw).to.be.false;
    });
  });

  describe("performUpkeep()", function () {
    it("Should allow OPERATOR_ROLE to perform upkeep when forwarder unset", async function () {
      const { lottery, admin, buyer1, buyer2, buyer3, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 3n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [, performData] = await lottery.checkUpkeep("0x");
      await lottery.connect(admin).performUpkeep(performData);
      expect(await lottery.status()).to.equal(2n); // Drawing
    });

    it("Should revert performUpkeep from unauthorized address when forwarder unset", async function () {
      const { lottery, stranger, buyer1, buyer2, buyer3, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 3n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [, performData] = await lottery.checkUpkeep("0x");
      await expect(
        lottery.connect(stranger).performUpkeep(performData)
      ).to.be.revertedWithCustomError(lottery, "NotAuthorizedForUpkeep");
    });

    it("Should allow the registered forwarder to perform upkeep", async function () {
      const { lottery, admin, forwarder, buyer1, buyer2, buyer3, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 3n });
      await lottery.connect(admin).setAutomationForwarder(forwarder.address);

      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [, performData] = await lottery.checkUpkeep("0x");
      await lottery.connect(forwarder).performUpkeep(performData);
      expect(await lottery.status()).to.equal(2n);
    });

    it("Should revert performUpkeep from non-forwarder, non-operator once forwarder is set", async function () {
      const { lottery, admin, forwarder, stranger, buyer1, buyer2, buyer3, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 3n });
      await lottery.connect(admin).setAutomationForwarder(forwarder.address);

      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer2).buyTickets(1n, { value: ticketPrice });
      await lottery.connect(buyer3).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [, performData] = await lottery.checkUpkeep("0x");
      await expect(
        lottery.connect(stranger).performUpkeep(performData)
      ).to.be.revertedWithCustomError(lottery, "NotAuthorizedForUpkeep");
    });

    it("Should trigger refund path via performUpkeep when minTickets not met", async function () {
      const { lottery, admin, buyer1, ticketPrice, ethers } =
        await setupAutomation({ minTickets: 5n });
      await lottery.connect(buyer1).buyTickets(1n, { value: ticketPrice });
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [, performData] = await lottery.checkUpkeep("0x");
      await lottery.connect(admin).performUpkeep(performData);
      expect(await lottery.status()).to.equal(4n); // Refunding
    });

    it("Should revert performUpkeep if drawTime not yet reached", async function () {
      const { lottery, admin } = await setupAutomation({ drawTimeOffset: 3600 });
      const fakePerformData = "0x0000000000000000000000000000000000000000000000000000000000000001";
      await expect(
        lottery.connect(admin).performUpkeep(fakePerformData)
      ).to.be.revertedWithCustomError(lottery, "UpkeepNotNeeded");
    });
  });

  describe("setAutomationForwarder()", function () {
    it("Should set the forwarder address", async function () {
      const { lottery, admin, forwarder } = await setupAutomation();
      await lottery.connect(admin).setAutomationForwarder(forwarder.address);
      expect(await lottery.automationForwarder()).to.equal(forwarder.address);
    });

    it("Should emit AutomationForwarderSet event", async function () {
      const { lottery, admin, forwarder } = await setupAutomation();
      await expect(lottery.connect(admin).setAutomationForwarder(forwarder.address))
        .to.emit(lottery, "AutomationForwarderSet")
        .withArgs(forwarder.address);
    });

    it("Should revert when called by non-admin", async function () {
      const { lottery, stranger, forwarder } = await setupAutomation();
      await expect(
        lottery.connect(stranger).setAutomationForwarder(forwarder.address)
      ).to.be.revertedWithCustomError(lottery, "AccessControlUnauthorizedAccount");
    });

    it("Should revert setting zero address as forwarder", async function () {
      const { lottery, admin, ethers } = await setupAutomation();
      await expect(
        lottery.connect(admin).setAutomationForwarder(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(lottery, "ZeroAddress");
    });
  });
});
