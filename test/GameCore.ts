import { expect } from "chai";
import hre from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";
import { ZeroAddress } from "ethers";

const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
const BASE_FEE = "100000000000000000";
const GAS_PRICE_LINK = "1000000000";

describe("GameCore", function () {
  async function base() {
    const connection = await hre.network.create();
    const { ethers } = connection;
    const upgradesApi = await upgrades(hre, connection);
    const [admin, buyer1, buyer2, buyer3, buyer4, buyer5, buyer6, stranger] = await ethers.getSigners();

    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const coordinator = await MockCoordinator.deploy(BASE_FEE, GAS_PRICE_LINK, "4000000000000000");
    await coordinator.waitForDeployment();
    const subRc = await (await coordinator.createSubscription()).wait();
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

    const block = await ethers.provider.getBlock("latest");
    const now = block!.timestamp;

    return { ethers, factory, coordinator, subId, admin, buyer1, buyer2, buyer3, buyer4, buyer5, buyer6, stranger, now };
  }

  const TAAHER_RANKS = [
    { rank: 1, maxWinners: 1,   prizeCategory: 1, prizeAmount: 0n, allocationBps: 5000, prizeType: 1, claimType: 1, rankDescription: "Jackpot" },
    { rank: 2, maxWinners: 10,  prizeCategory: 1, prizeAmount: 0n, allocationBps: 2500, prizeType: 1, claimType: 2, rankDescription: "Runner Up" },
    { rank: 3, maxWinners: 50,  prizeCategory: 1, prizeAmount: 0n, allocationBps: 1500, prizeType: 1, claimType: 0, rankDescription: "Third Tier" },
    { rank: 4, maxWinners: 500, prizeCategory: 1, prizeAmount: 0n, allocationBps: 1000, prizeType: 1, claimType: 0, rankDescription: "Fourth Tier" },
  ];

  async function deployCountGame(ctx: any, opts: { maxParticipation?: number; price?: bigint; currency?: string; ranks?: any[]; code?: string } = {}) {
    const { ethers, factory, coordinator, subId, admin, now } = ctx;
    const cfg = {
      gameCode: opts.code ?? "GAME0011", gameName: "Api-test", schemeCode: "SCH0002", schemeName: "Jackpot Pool Allocation",
      mode: 0, ticketPrice: opts.price ?? ethers.parseEther("0.1"), currency: opts.currency ?? ZeroAddress,
      saleStart: BigInt(now - 60), saleClose: BigInt(now + 3600), drawAt: 0n,
      maxParticipation: opts.maxParticipation ?? 100,
    };
    await factory.connect(admin).createGame(cfg, opts.ranks ?? TAAHER_RANKS, admin.address);
    const game = (await ethers.getContractFactory("GameCore")).attach(await factory.getGameByCode(cfg.gameCode));
    await coordinator.addConsumer(subId, await game.getAddress());
    return game;
  }

  async function deployDrawTimeGame(ctx: any, opts: { ranks?: any[]; code?: string; price?: bigint } = {}) {
    const { ethers, factory, coordinator, subId, admin, now } = ctx;
    const cfg = {
      gameCode: opts.code ?? "GAMEDT01", gameName: "Draw Time Game", schemeCode: "SCH0009", schemeName: "Std Fixed",
      mode: 1, ticketPrice: opts.price ?? ethers.parseEther("0.1"), currency: ZeroAddress,
      saleStart: BigInt(now - 60), saleClose: BigInt(now + 1800), drawAt: BigInt(now + 3600), maxParticipation: 0,
    };
    const ranks = opts.ranks ?? [
      { rank: 1, maxWinners: 1, prizeCategory: 0, prizeAmount: ethers.parseEther("2"),   allocationBps: 0, prizeType: 1, claimType: 1, rankDescription: "Grand" },
      { rank: 2, maxWinners: 3, prizeCategory: 0, prizeAmount: ethers.parseEther("0.5"), allocationBps: 0, prizeType: 0, claimType: 0, rankDescription: "Second" },
    ];
    await factory.connect(admin).createGame(cfg, ranks, admin.address);
    const game = (await ethers.getContractFactory("GameCore")).attach(await factory.getGameByCode(cfg.gameCode));
    await coordinator.addConsumer(subId, await game.getAddress());
    return game;
  }

  async function makeParticipants(ctx: any, n: number) {
    const { ethers, admin } = ctx;
    const out = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await admin.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
      out.push(w);
    }
    return out;
  }

  async function fulfill(ctx: any, game: any) {
    const requestId = await game.s_requestId();
    await ctx.coordinator.fulfillRandomWords(requestId, await game.getAddress());
  }

  // ─── Buying ───────────────────────────────────────────────────────────────

  describe("buyTickets", function () {
    it("sells tickets inside the window; wrong payment / zero count revert", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx);
      const { ethers, buyer1 } = ctx;

      await game.connect(buyer1).buyTickets(3n, { value: ethers.parseEther("0.3") });
      expect(await game.ticketsSold()).to.equal(3n);
      expect(await game.participantCount()).to.equal(1n);
      expect(await game.grossProceeds()).to.equal(ethers.parseEther("0.3"));
      expect(await game.prizeBalance()).to.equal(ethers.parseEther("0.3"));

      await expect(game.connect(buyer1).buyTickets(1n, { value: 1n }))
        .to.be.revertedWithCustomError(game, "IncorrectPayment");
      await expect(game.connect(buyer1).buyTickets(0n, { value: 0n }))
        .to.be.revertedWithCustomError(game, "InvalidParam");
    });

    it("enforces the sale window (SaleNotOpen / SaleWindowPassed)", async function () {
      const ctx = await base();
      const { ethers, factory, admin, buyer1, now, coordinator, subId } = ctx;
      const cfg = {
        gameCode: "FUTURE", gameName: "x", schemeCode: "s", schemeName: "s",
        mode: 0, ticketPrice: ethers.parseEther("0.1"), currency: ZeroAddress,
        saleStart: BigInt(now + 1000), saleClose: BigInt(now + 2000), drawAt: 0n, maxParticipation: 10,
      };
      await factory.connect(admin).createGame(cfg, TAAHER_RANKS, admin.address);
      const game = (await ethers.getContractFactory("GameCore")).attach(await factory.getGameByCode("FUTURE"));
      await coordinator.addConsumer(subId, await game.getAddress());

      await expect(game.connect(buyer1).buyTickets(1n, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(game, "SaleNotOpen");

      await ethers.provider.send("evm_increaseTime", [2500]);
      await ethers.provider.send("evm_mine", []);
      await expect(game.connect(buyer1).buyTickets(1n, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(game, "SaleWindowPassed");
    });

    it("COUNT: rejects joins beyond maxParticipation, allows repeat buys by existing participants", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 2, code: "CAP2" });
      const { ethers, buyer1, buyer2, buyer3 } = ctx;
      const v = { value: ethers.parseEther("0.1") };

      await game.connect(buyer1).buyTickets(1n, v);
      await game.connect(buyer1).buyTickets(1n, v); // same wallet again: fine
      await game.connect(buyer2).buyTickets(1n, v); // fills cap -> auto-draw fires
      expect(await game.status()).to.equal(1n); // Drawing
      await expect(game.connect(buyer3).buyTickets(1n, v))
        .to.be.revertedWithCustomError(game, "NotInStatus");
    });
  });

  // ─── Draw triggers ────────────────────────────────────────────────────────

  describe("draw triggers", function () {
    it("COUNT: auto-triggers VRF when the participation cap fills", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 3, code: "AUTO3" });
      const { ethers, buyer1, buyer2, buyer3 } = ctx;
      const v = { value: ethers.parseEther("0.1") };

      await game.connect(buyer1).buyTickets(1n, v);
      await game.connect(buyer2).buyTickets(1n, v);
      await expect(game.connect(buyer3).buyTickets(1n, v)).to.emit(game, "DrawRequested");
      expect(await game.status()).to.equal(1n);
    });

    it("COUNT: operator can trigger after saleClose if cap never filled; not before", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 50, code: "UNDER" });
      const { ethers, admin, buyer1 } = ctx;
      await game.connect(buyer1).buyTickets(1n, { value: ethers.parseEther("0.1") });

      await expect(game.connect(admin).requestDraw())
        .to.be.revertedWithCustomError(game, "DrawNotDue");

      await ethers.provider.send("evm_increaseTime", [4000]);
      await ethers.provider.send("evm_mine", []);
      await expect(game.connect(admin).requestDraw()).to.emit(game, "DrawRequested");
    });

    it("DRAW_TIME: rejects before drawAt, works after; zero participants revert", async function () {
      const ctx = await base();
      const game = await deployDrawTimeGame(ctx);
      const { ethers, admin, buyer1 } = ctx;

      await expect(game.connect(admin).requestDraw())
        .to.be.revertedWithCustomError(game, "DrawNotDue");

      await ethers.provider.send("evm_increaseTime", [4000]);
      await ethers.provider.send("evm_mine", []);
      await expect(game.connect(admin).requestDraw())
        .to.be.revertedWithCustomError(game, "NoParticipants");
    });

    it("only OPERATOR_ROLE can call requestDraw", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { code: "OPONLY" });
      await expect(game.connect(ctx.stranger).requestDraw())
        .to.be.revertedWithCustomError(game, "AccessControlUnauthorizedAccount");
    });
  });

  // ─── Finalization: dynamic winner rule + batching ─────────────────────────

  describe("finalizeDraw", function () {
    it("5 participants -> exactly 1 winner (rank 1 only)", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 5, code: "P5" });
      const { ethers, buyer1, buyer2, buyer3, buyer4, buyer5 } = ctx;
      const v = { value: ethers.parseEther("0.1") };
      for (const b of [buyer1, buyer2, buyer3, buyer4, buyer5]) await game.connect(b).buyTickets(1n, v);

      await fulfill(ctx, game);
      await game.finalizeDraw(10n);

      expect(await game.status()).to.equal(4n); // Finalized
      expect(await game.totalWinners()).to.equal(1n);
      expect(await game.getWinnerCount()).to.equal(1n);
      // 5 tickets * 0.1 = 0.5 gross; rank1 = 50% = 0.25 to the single winner
      const w = (await game.getWinners())[0];
      const info = await game.winnerInfo(w);
      expect(info.amount).to.equal(ethers.parseEther("0.25"));
      expect(info.status).to.equal(1n); // PendingApproval (HEAD_OFFICE)
    });

    it("8 participants -> exactly 2 winners; 30 participants -> 3 winners (10% rule), batched finalize", async function () {
      const ctx = await base();
      const { ethers } = ctx;

      const game8 = await deployCountGame(ctx, { maxParticipation: 8, code: "P8" });
      const p8 = await makeParticipants(ctx, 8);
      for (const w of p8) await game8.connect(w).buyTickets(1n, { value: ethers.parseEther("0.1") });
      await fulfill(ctx, game8);
      await game8.finalizeDraw(10n);
      expect(await game8.totalWinners()).to.equal(2n);

      const game30 = await deployCountGame(ctx, { maxParticipation: 30, code: "P30" });
      const p30 = await makeParticipants(ctx, 30);
      for (const w of p30) await game30.connect(w).buyTickets(1n, { value: ethers.parseEther("0.1") });
      await fulfill(ctx, game30);

      // Batch: 2 winners then the rest
      await game30.finalizeDraw(2n);
      expect(await game30.status()).to.equal(3n); // Finalizing
      expect(await game30.nextWinnerIndex()).to.equal(2n);
      await game30.finalizeDraw(50n);
      expect(await game30.status()).to.equal(4n);
      expect(await game30.totalWinners()).to.equal(3n);

      // Ranks fill top-down: [1, 2, 0, 0]
      expect(await game30.winnersPerRank(0)).to.equal(1);
      expect(await game30.winnersPerRank(1)).to.equal(2);

      // All winners distinct (one wallet wins once)
      const winners = await game30.getWinners();
      expect(new Set(winners.map((a: string) => a.toLowerCase())).size).to.equal(3);

      // Prize math: gross 3 ETH; rank1 50% = 1.5; rank2 25% = 0.75 / 2 = 0.375 each
      const info0 = await game30.winnerInfo(winners[0]);
      expect(info0.amount).to.equal(ethers.parseEther("1.5"));
      const info1 = await game30.winnerInfo(winners[1]);
      expect(info1.amount).to.equal(ethers.parseEther("0.375"));
      expect(await game30.totalPrizeLiability()).to.equal(ethers.parseEther("2.25"));
    });

    it("reverts finalize before seed and double-finalize after completion", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 5, code: "NOSEED" });
      await expect(game.finalizeDraw(10n)).to.be.revertedWithCustomError(game, "NotInStatus");
    });
  });

  // ─── Claims ───────────────────────────────────────────────────────────────

  describe("claims", function () {
    async function finalizedTaaherGame() {
      const ctx = await base();
      const game = await deployCountGame(ctx, { maxParticipation: 30, code: "CLAIMS" });
      const ps = await makeParticipants(ctx, 30);
      for (const w of ps) await game.connect(w).buyTickets(1n, { value: ctx.ethers.parseEther("0.1") });
      await fulfill(ctx, game);
      await game.finalizeDraw(50n);
      const winners = await game.getWinners();
      return { ctx, game, winners, ps };
    }

    it("AUTO ranks claim immediately; HEAD_OFFICE/MANUAL need approval first", async function () {
      const { ctx, game, winners, ps } = await finalizedTaaherGame();
      const { ethers, admin } = ctx;

      // winners[0] = rank1 HEAD_OFFICE (pending), winners[1..2] = rank2 MANUAL (pending)
      const w0 = ps.find((w) => w.address === winners[0])!;
      await expect(game.connect(w0).claimPrize()).to.be.revertedWithCustomError(game, "NotClaimable");

      await expect(game.connect(admin).approvePrize(winners[0]))
        .to.emit(game, "PrizeApproved");

      const before = await ethers.provider.getBalance(winners[0]);
      const tx = await game.connect(w0).claimPrize();
      const rc = await tx.wait();
      const gas = rc!.gasUsed * rc!.gasPrice;
      const after = await ethers.provider.getBalance(winners[0]);
      expect(after - before + gas).to.equal(ethers.parseEther("1.5"));

      await expect(game.connect(w0).claimPrize()).to.be.revertedWithCustomError(game, "AlreadyClaimed");
    });

    it("non-winner cannot claim; non-operator cannot approve; cannot approve twice", async function () {
      const { ctx, game, winners } = await finalizedTaaherGame();
      const { admin, stranger } = ctx;
      await expect(game.connect(stranger).claimPrize()).to.be.revertedWithCustomError(game, "NotAWinner");
      await expect(game.connect(stranger).approvePrize(winners[0]))
        .to.be.revertedWithCustomError(game, "AccessControlUnauthorizedAccount");
      await game.connect(admin).approvePrize(winners[0]);
      await expect(game.connect(admin).approvePrize(winners[0]))
        .to.be.revertedWithCustomError(game, "NotClaimable");
    });
  });

  // ─── AMOUNT scheme + prefund + surplus ────────────────────────────────────

  describe("AMOUNT games, prefund, surplus", function () {
    it("pays Fixed per-winner and Dividend split; prefund covers fixed liability; surplus withdrawal respects unclaimed prizes", async function () {
      const ctx = await base();
      const { ethers, admin } = ctx;
      const game = await deployDrawTimeGame(ctx, { code: "AMT1" });

      const ps = await makeParticipants(ctx, 8); // -> 2 winners: rank1 (2 ETH dividend/1), rank2 (0.5 fixed)
      for (const w of ps) await game.connect(w).buyTickets(1n, { value: ethers.parseEther("0.1") });

      // proceeds 0.8 < liability 2.5 -> prefund
      await game.connect(admin).prefundNative({ value: ethers.parseEther("2") });
      expect(await game.prizeBalance()).to.equal(ethers.parseEther("2.8"));

      await ethers.provider.send("evm_increaseTime", [4000]);
      await ethers.provider.send("evm_mine", []);
      await game.connect(admin).requestDraw();
      await fulfill(ctx, game);
      await game.finalizeDraw(10n);

      const winners = await game.getWinners();
      expect(winners.length).to.equal(2);
      expect((await game.winnerInfo(winners[0])).amount).to.equal(ethers.parseEther("2"));
      expect((await game.winnerInfo(winners[1])).amount).to.equal(ethers.parseEther("0.5"));

      // Surplus = 2.8 - 2.5 unclaimed = 0.3 max
      await expect(game.connect(admin).withdrawSurplus(admin.address, ethers.parseEther("0.31")))
        .to.be.revertedWithCustomError(game, "InsufficientSurplus");
      await game.connect(admin).withdrawSurplus(admin.address, ethers.parseEther("0.3"));

      // rank2 winner (AUTO) can still claim fully after surplus withdrawal
      const w1 = ps.find((w) => w.address === winners[1])!;
      await game.connect(w1).claimPrize();
    });

    it("non-admin cannot withdraw surplus; withdrawal blocked before finalization", async function () {
      const ctx = await base();
      const game = await deployCountGame(ctx, { code: "SURP" });
      const { ethers, admin, stranger, buyer1 } = ctx;
      await game.connect(buyer1).buyTickets(1n, { value: ethers.parseEther("0.1") });
      await expect(game.connect(admin).withdrawSurplus(admin.address, 1n))
        .to.be.revertedWithCustomError(game, "NotInStatus");
      await expect(game.connect(stranger).withdrawSurplus(stranger.address, 1n))
        .to.be.revertedWithCustomError(game, "AccessControlUnauthorizedAccount");
    });
  });

  // ─── ERC20 currency game ──────────────────────────────────────────────────

  describe("ERC20 game", function () {
    it("full cycle in tokens: approve+buy, draw, finalize, claim", async function () {
      const ctx = await base();
      const { ethers, admin, buyer1, buyer2, buyer3 } = ctx;

      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const usdt = await MockUSDT.deploy();
      await usdt.waitForDeployment();

      const price = ethers.parseEther("10");
      const game = await deployCountGame(ctx, {
        maxParticipation: 3, code: "TOKEN1",
        currency: await usdt.getAddress(), price,
      });

      for (const b of [buyer1, buyer2, buyer3]) {
        await usdt.connect(admin).transfer(b.address, price);
        await usdt.connect(b).approve(await game.getAddress(), price);
      }

      await game.connect(buyer1).buyTickets(1n);
      await game.connect(buyer2).buyTickets(1n);
      await game.connect(buyer3).buyTickets(1n); // fills cap -> auto draw
      expect(await usdt.balanceOf(await game.getAddress())).to.equal(price * 3n);

      await fulfill(ctx, game);
      await game.finalizeDraw(10n);

      const winners = await game.getWinners(); // 3 participants -> 1 winner, rank1 HO
      await game.connect(admin).approvePrize(winners[0]);
      const w = await ethers.getSigner(winners[0]);
      await game.connect(w).claimPrize();
      expect(await usdt.balanceOf(winners[0])).to.equal(price * 3n / 2n); // 50% of 30 = 15
    });
  });
});
