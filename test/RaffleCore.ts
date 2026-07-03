import { expect } from "chai";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
const CALLBACK_GAS_LIMIT = 500_000;
const REQUEST_CONFIRMATIONS = 3;
const BASE_FEE = "100000000000000000";
const GAS_PRICE_LINK = "1000000000";

describe("RaffleCore", function () {

  async function setupBase() {
    const connection = await hre.network.create();
    const { ethers } = connection;

    const [admin, entrant1, entrant2, entrant3, stranger] =
      await ethers.getSigners();

    const MockCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const mockCoordinator = await MockCoordinator.deploy(BASE_FEE, GAS_PRICE_LINK, "4000000000000000");
    await mockCoordinator.waitForDeployment();

    const createSubTx = await mockCoordinator.createSubscription();
    const receipt = await createSubTx.wait();
    const subLog = receipt!.logs.find((l: any) => l.fragment?.name === "SubscriptionCreated") as any;
    const subscriptionId: bigint = subLog.args[0];
    await mockCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    const MockERC721 = await ethers.getContractFactory("MockERC721");
    const mockNFT = await MockERC721.deploy();
    await mockNFT.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockERC20.deploy();
    await mockToken.waitForDeployment();

    return {
      ethers, mockCoordinator, subscriptionId, mockNFT, mockToken,
      admin, entrant1, entrant2, entrant3, stranger,
    };
  }

  async function deployERC721Raffle(overrides: {
    entryFee?: bigint; isCharity?: boolean; isWhitelisted?: boolean;
    whitelistRoot?: string; deadlineOffset?: number;
  } = {}, existingBase?: Awaited<ReturnType<typeof setupBase>>) {
    const base = existingBase ?? await setupBase();
    const { ethers, mockCoordinator, subscriptionId, mockNFT, admin } = base;
    const tokenId = await mockNFT.mint.staticCall(admin.address);
    await mockNFT.mint(admin.address);
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp + (overrides.deadlineOffset ?? 60));
    const RaffleCore = await ethers.getContractFactory("RaffleCore");
    const raffle = await RaffleCore.deploy(
      {
        vrfCoordinator: await mockCoordinator.getAddress(),
        subscriptionId, keyHash: KEY_HASH,
        callbackGasLimit: CALLBACK_GAS_LIMIT, requestConfirmations: REQUEST_CONFIRMATIONS,
      },
      {
        factory: admin.address, raffleId: 0n, admin: admin.address,
        prizeType: 0, // ERC721
        prizeAsset: await mockNFT.getAddress(),
        prizeTokenId: tokenId,
        prizeAmount: 0n,
        entryFee: overrides.entryFee ?? 0n,
        isCharity: overrides.isCharity ?? true,
        isWhitelisted: overrides.isWhitelisted ?? false,
        whitelistRoot: overrides.whitelistRoot ?? ethers.ZeroHash,
        entryDeadline: deadline,
      }
    );
    await raffle.waitForDeployment();
    await mockCoordinator.addConsumer(subscriptionId, await raffle.getAddress());
    await mockNFT.connect(admin).approve(await raffle.getAddress(), tokenId);
    return { ...base, raffle, RaffleCore, tokenId, deadline };
  }

  async function deployERC20Raffle(overrides: {
    entryFee?: bigint; isCharity?: boolean; deadlineOffset?: number;
  } = {}) {
    const base = await setupBase();
    const { ethers, mockCoordinator, subscriptionId, mockToken, admin } = base;

    const prizeAmount = ethers.parseEther("1000");
    const block = await ethers.provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp + (overrides.deadlineOffset ?? 60));

    const RaffleCore = await ethers.getContractFactory("RaffleCore");
    const raffle = await RaffleCore.deploy(
      {
        vrfCoordinator: await mockCoordinator.getAddress(),
        subscriptionId, keyHash: KEY_HASH,
        callbackGasLimit: CALLBACK_GAS_LIMIT, requestConfirmations: REQUEST_CONFIRMATIONS,
      },
      {
        factory: admin.address, raffleId: 0n, admin: admin.address,
        prizeType: 1, // ERC20
        prizeAsset: await mockToken.getAddress(),
        prizeTokenId: 0n,
        prizeAmount,
        entryFee: overrides.entryFee ?? 0n,
        isCharity: overrides.isCharity ?? true,
        isWhitelisted: false,
        whitelistRoot: ethers.ZeroHash,
        entryDeadline: deadline,
      }
    );
    await raffle.waitForDeployment();
    await mockCoordinator.addConsumer(subscriptionId, await raffle.getAddress());

    await mockToken.connect(admin).approve(await raffle.getAddress(), prizeAmount);

    return { ...base, raffle, RaffleCore, prizeAmount, deadline };
  }

  // ─── Deployment + Prize Deposit ──────────────────────────────────────────

  describe("Deployment + Prize Deposit", function () {
    it("Should deploy in Created status before prize deposit", async function () {
      const { raffle } = await deployERC721Raffle();
      expect(await raffle.status()).to.equal(0n); // Created
    });

    it("Should transition to Open after ERC721 prize deposit", async function () {
      const { raffle, admin } = await deployERC721Raffle();
      await raffle.connect(admin).depositERC721Prize();
      expect(await raffle.status()).to.equal(1n); // Open
    });

    it("Should hold the deposited NFT", async function () {
      const { raffle, admin, mockNFT, tokenId } = await deployERC721Raffle();
      await raffle.connect(admin).depositERC721Prize();
      expect(await mockNFT.ownerOf(tokenId)).to.equal(await raffle.getAddress());
    });

    it("Should transition to Open after ERC20 prize deposit", async function () {
      const { raffle, admin } = await deployERC20Raffle();
      await raffle.connect(admin).depositERC20Prize();
      expect(await raffle.status()).to.equal(1n);
    });

    it("Should hold the deposited ERC20 amount", async function () {
      const { raffle, admin, mockToken, prizeAmount } = await deployERC20Raffle();
      await raffle.connect(admin).depositERC20Prize();
      expect(await mockToken.balanceOf(await raffle.getAddress())).to.equal(prizeAmount);
    });
  });

  // ─── Entry (charity, free) ───────────────────────────────────────────────

  describe("enter() — charity (free entry)", function () {
    it("Should allow free entry when isCharity is true", async function () {
      const { raffle, admin, entrant1 } = await deployERC721Raffle({ isCharity: true });
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      expect(await raffle.hasEntered(entrant1.address)).to.be.true;
    });

    it("Should emit EntrySubmitted with feePaid 0", async function () {
      const { raffle, admin, entrant1 } = await deployERC721Raffle({ isCharity: true });
      await raffle.connect(admin).depositERC721Prize();
      await expect(raffle.connect(entrant1).enter([]))
        .to.emit(raffle, "EntrySubmitted")
        .withArgs(0n, entrant1.address, 0n);
    });

    it("Should revert on double entry", async function () {
      const { raffle, admin, entrant1 } = await deployERC721Raffle({ isCharity: true });
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      await expect(
        raffle.connect(entrant1).enter([])
      ).to.be.revertedWithCustomError(raffle, "AlreadyEntered");
    });
  });

  // ─── Entry (paid) ────────────────────────────────────────────────────────

  describe("enter() — paid entry", function () {
    it("Should require exact entry fee", async function () {
      const { raffle, admin, entrant1, ethers } =
        await deployERC721Raffle({ isCharity: false, entryFee: 50000000000000000n });
      await raffle.connect(admin).depositERC721Prize();

      await expect(
        raffle.connect(entrant1).enter([], { value: ethers.parseEther("0.01") })
      ).to.be.revertedWithCustomError(raffle, "IncorrectPayment");

      await raffle.connect(entrant1).enter([], { value: ethers.parseEther("0.05") });
      expect(await raffle.hasEntered(entrant1.address)).to.be.true;
    });

    it("Should force entryFee to 0 if isCharity is true even if entryFee param set", async function () {
      const { raffle } = await deployERC721Raffle({ isCharity: true, entryFee: 999n });
      expect(await raffle.entryFee()).to.equal(0n);
    });
  });

  // ─── Entry (whitelist / Merkle proof) ────────────────────────────────────

  describe("enter() — whitelist (Merkle proof)", function () {
    it("Should allow whitelisted address to enter with valid proof", async function () {
      const base = await setupBase();
      const { ethers, entrant1, entrant2 } = base;
      const tree = StandardMerkleTree.of(
        [[entrant1.address], [entrant2.address]],
        ["address"]
      );
      const root = tree.root;
      const proof1 = tree.getProof([entrant1.address]);
      const { raffle, admin } = await deployERC721Raffle({
        isCharity: true, isWhitelisted: true, whitelistRoot: root,
      }, base);
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter(proof1);
      expect(await raffle.hasEntered(entrant1.address)).to.be.true;
    });
    it("Should revert non-whitelisted address even with a proof for someone else", async function () {
      const base = await setupBase();
      const { entrant1, entrant2, stranger } = base;
      const tree = StandardMerkleTree.of(
        [[entrant1.address], [entrant2.address]],
        ["address"]
      );
      const root = tree.root;
      const proof1 = tree.getProof([entrant1.address]);
      const { raffle, admin } = await deployERC721Raffle({
        isCharity: true, isWhitelisted: true, whitelistRoot: root,
      }, base);
      await raffle.connect(admin).depositERC721Prize();
      await expect(
        raffle.connect(stranger).enter(proof1)
      ).to.be.revertedWithCustomError(raffle, "NotWhitelisted");
    });
  });

  // ─── Draw + Winner Selection ─────────────────────────────────────────────

  describe("requestDraw() + VRF winner selection", function () {
    async function setupWithEntrants() {
      const ctx = await deployERC721Raffle({ isCharity: true, deadlineOffset: 60 });
      const { raffle, admin, entrant1, entrant2, entrant3, ethers } = ctx;
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      await raffle.connect(entrant2).enter([]);
      await raffle.connect(entrant3).enter([]);
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      return ctx;
    }

    it("Should select a valid winner from entrants", async function () {
      const { raffle, admin, mockCoordinator, entrant1, entrant2, entrant3 } =
        await setupWithEntrants();

      await raffle.connect(admin).requestDraw();
      const requestId = await raffle.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await raffle.getAddress());

      expect(await raffle.status()).to.equal(3n); // Completed
      const w = await raffle.winner();
      expect([entrant1.address, entrant2.address, entrant3.address]).to.include(w);
    });

    it("Should revert requestDraw with zero entrants", async function () {
      const { raffle, admin, ethers } =
        await deployERC721Raffle({ isCharity: true, deadlineOffset: 60 });
      await raffle.connect(admin).depositERC721Prize();
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        raffle.connect(admin).requestDraw()
      ).to.be.revertedWithCustomError(raffle, "NoEntrants");
    });
  });

  // ─── Prize Claim ─────────────────────────────────────────────────────────

  describe("claimPrize() — ERC721", function () {
    it("Should transfer the NFT to the winner", async function () {
      const ctx = await deployERC721Raffle({ isCharity: true, deadlineOffset: 60 });
      const { raffle, admin, entrant1, entrant2, entrant3, ethers, mockCoordinator, mockNFT, tokenId } = ctx;
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      await raffle.connect(entrant2).enter([]);
      await raffle.connect(entrant3).enter([]);
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await raffle.connect(admin).requestDraw();
      const requestId = await raffle.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await raffle.getAddress());

      const winnerAddr = await raffle.winner();
      const winnerSigner = await ethers.getSigner(winnerAddr);

      await raffle.connect(winnerSigner).claimPrize();
      expect(await mockNFT.ownerOf(tokenId)).to.equal(winnerAddr);
    });
  });

  describe("claimPrize() — ERC20", function () {
    it("Should transfer the token amount to the winner", async function () {
      const ctx = await deployERC20Raffle({ isCharity: true, deadlineOffset: 60 });
      const { raffle, admin, entrant1, entrant2, entrant3, ethers, mockCoordinator, mockToken, prizeAmount } = ctx;
      await raffle.connect(admin).depositERC20Prize();
      await raffle.connect(entrant1).enter([]);
      await raffle.connect(entrant2).enter([]);
      await raffle.connect(entrant3).enter([]);
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      await raffle.connect(admin).requestDraw();
      const requestId = await raffle.s_requestId();
      await mockCoordinator.fulfillRandomWords(requestId, await raffle.getAddress());

      const winnerAddr = await raffle.winner();
      const winnerSigner = await ethers.getSigner(winnerAddr);

      await raffle.connect(winnerSigner).claimPrize();
      expect(await mockToken.balanceOf(winnerAddr)).to.equal(prizeAmount);
    });
  });

  // ─── Cancellation ────────────────────────────────────────────────────────

  describe("cancelRaffle() + claimEntryRefund()", function () {
    it("Should return NFT prize to operator on cancellation", async function () {
      const { raffle, admin, mockNFT, tokenId } = await deployERC721Raffle();
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(admin).cancelRaffle();
      expect(await mockNFT.ownerOf(tokenId)).to.equal(admin.address);
      expect(await raffle.status()).to.equal(4n); // Cancelled
    });

    it("Should refund paid entrants on cancellation", async function () {
      const { raffle, admin, entrant1, ethers } =
        await deployERC721Raffle({ isCharity: false, entryFee: 100000000000000000n });
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([], { value: ethers.parseEther("0.1") });
      await raffle.connect(admin).cancelRaffle();

      const before = await ethers.provider.getBalance(entrant1.address);
      const tx = await raffle.connect(entrant1).claimEntryRefund();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(entrant1.address);

      expect(after - before + gasUsed).to.equal(ethers.parseEther("0.1"));
    });
  });

  // ─── Automation ──────────────────────────────────────────────────────────

  describe("Chainlink Automation", function () {
    it("checkUpkeep should return true when deadline passed with entrants", async function () {
      const ctx = await deployERC721Raffle({ isCharity: true, deadlineOffset: 60 });
      const { raffle, admin, entrant1, ethers } = ctx;
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const [upkeepNeeded] = await raffle.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
    });

    it("performUpkeep should trigger the draw", async function () {
      const ctx = await deployERC721Raffle({ isCharity: true, deadlineOffset: 60 });
      const { raffle, admin, entrant1, ethers } = ctx;
      await raffle.connect(admin).depositERC721Prize();
      await raffle.connect(entrant1).enter([]);
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await raffle.connect(admin).performUpkeep("0x");
      expect(await raffle.status()).to.equal(2n); // Drawing
    });
  });
});
