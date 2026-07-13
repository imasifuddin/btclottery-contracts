# btclottery.io — Locked Requirement & Contract Architecture

This document is the single source of truth for what the client has confirmed they want, as of this stage of the project. It exists so that if the client requests changes later (post-demo), we have a clear record of what "the original ask" actually was, and can clearly identify what changed.

---

## 1. The Locked Requirement (client's own description)

> A person opens the project website and sees all kinds of lotteries available — "Raffle 1", "Raffle 2", etc. The admin decides how many people can join a given lottery. Once that many people join, the draw happens automatically and winner(s) are selected. To buy in, the user connects their wallet (MetaMask or similar) and enters the game. Once the lottery is full according to the admin's rules, all winners are selected randomly using Chainlink VRF — if it's a 1-winner lottery, 1 winner is picked; if it's a 3-4 winner lottery, 3-4 winners are picked.

This is modeled directly on **btclottery.io**'s live "Fixed Lotteries" product (reference screenshots and links reviewed together). Key confirmed behaviors observed and matched:

- Each lottery has a **fixed player cap** set by the admin (e.g. 20, 10, 5 players)
- The draw is **capacity-triggered** — it fires the moment the last ticket sells, not on a timer or deadline
- **No refund mechanism exists** — since a lottery cannot complete until full, there's nothing to refund
- **Multiple winners per lottery are supported** — 1 winner for simple lotteries, or multiple ranked winners (1st/2nd/3rd/4th) with different prize shares for bigger ones
- **Multiple lotteries run simultaneously and independently** — a user can browse and enter as many as they like
- Wallet connection (MetaMask, and others) happens at the point of buying a ticket, not required just to browse
- Confirmed with the client: **admin retains full control** — no DAO/community voting planned
- Rolling jackpot (unclaimed pool carrying to the next draw) and Referral rewards are **pending client confirmation** — not yet locked, not yet built (see Section 4)

---

## 2. Contracts Needed for This Requirement, and Why

Only what's actually required for the locked flow above. Each entry explains its purpose in plain terms.

### `LotteryFactory.sol`
**What it's for:** The admin's tool for creating a new lottery. Instead of manually deploying a new contract by hand every time, the admin panel will call one function — `createLottery(ticketPrice, maxTickets, schemeId)` — and this factory deploys a brand-new lottery instance automatically, remembers its address, and makes it discoverable to the frontend.

**Why a separate contract instead of just deploying lotteries by hand:** consistency, speed, and a single place that knows every lottery that has ever existed on the platform (`getAllLotteries()`).

**Upgradeable:** Yes. This is permanent, long-lived infrastructure — if we need to fix something or add a feature to how lotteries get created, we can do so without changing its address or disrupting anything already running.

---

### `LotteryCore.sol`
**What it's for:** This is one actual lottery — "Raffle 1", "Raffle 2", however the frontend labels it. One of these gets deployed for every lottery the admin creates.

**How it matches the locked requirement, step by step:**
- Admin sets the **player/ticket cap** at creation (`maxTickets`) — this is "how many people can join," directly per the client's description.
- Users call `buyTickets(count)`, paying with their connected wallet.
- **The moment the cap is reached**, the same transaction that bought the final ticket **automatically triggers the draw** — no admin action, no waiting, no separate button. This matches "once all join according to admin rules then all winners will be selected."
- Chainlink VRF is used to pick the winner(s) — genuinely random, impossible to predict or manipulate by anyone, including the platform.
- **Supports 1 winner or multiple winners per lottery**, exactly as described — this is controlled by which prize scheme the lottery references (see `PrizeSchemeRegistry` below). A "1-winner lottery" uses a scheme with a single 100%-of-pool tier; a "3-4 winner lottery" uses a scheme with 3-4 ranked tiers (e.g. 50%/30%/15%/5%).
- No deadlines, no minimum-ticket thresholds, no refunds anywhere in this contract — deliberately removed to match the confirmed capacity-only trigger model.

**Upgradeable:** No. Each lottery is a one-time, disposable contest — once it's created, its rules should never change mid-game, which is exactly what non-upgradeability guarantees to users.

---

### `PrizeSchemeRegistry.sol`
**What it's for:** Where the admin defines "how many winners, and what share each winner gets" as a reusable template, instead of typing it out fresh every time.

**How it maps to the requirement:** the client said "if it's a 1-winner lottery then 1 winner, or if it's 3-4 winner lotteries then 3-4 winners." This is exactly what a "scheme" represents:
- A "Winner Takes All" scheme = 1 tier, ~95-100% to that single winner
- A "4-Tier" scheme = 4 tiers, e.g. 1st gets 45%, 2nd gets 30%, 3rd gets 15%, 4th gets 10%

Admin creates these schemes once, and every new lottery just points at whichever scheme fits (`schemeId`).

**Upgradeable:** Yes — pure configuration data, no funds or user assets involved, safe to evolve without needing to change addresses.

---

### `BTCLPToken.sol` and `TicketNFT.sol`
**Current relevance to the locked requirement:** Not part of the core flow described above. `BTCLPToken` exists for possible future governance/rewards use (not active yet). `TicketNFT` was built to make tickets visible as NFTs in a user's wallet, but **is not yet wired into `LotteryCore.buyTickets()`** — right now a "ticket" is just an internal count, not an actual minted NFT. This can be added later without disrupting the core lottery mechanic if the client wants tickets to visually appear in wallets.

---

### `RaffleCore.sol`
**Current relevance:** This is a *separate* product type (donated NFT/token prizes, not pooled cash) — not what the client described in the locked requirement above, which is specifically about pooled-ticket-sale lotteries. `RaffleCore` remains available if/when the platform wants to run donated-prize raffles alongside lotteries, but is not part of this specific locked flow.

---

## 3. How the Locked Flow Actually Works, End to End

1. **User opens the site** → sees a list of lotteries (e.g. "Raffle 1: 15/20 players, prize pool 20 MATIC"), each one reading live from its own `LotteryCore` contract via `LotteryFactory.getAllLotteries()`.
2. **User clicks "Buy Ticket"** → prompted to connect a wallet (MetaMask or other) if not already connected.
3. **User confirms the transaction** → calls `LotteryCore.buyTickets(1)` with the exact ticket price.
4. **If the lottery isn't full yet:** the purchase is simply recorded; the lottery stays open for others to join.
5. **If this purchase fills the lottery:** in that same transaction, the contract automatically requests a random draw from Chainlink VRF — this is the "once all join according to admin rules" moment, and it happens without anyone needing to click anything further.
6. **Chainlink responds (usually seconds to a couple of minutes later)** with verified randomness. The contract selects however many winners the lottery's prize scheme specifies — 1, or 3-4, exactly per the client's description — weighted fairly by how many tickets each person bought.
7. **Winners are now public and visible on-chain** — anyone can see who won, immediately, no waiting for an announcement.
8. **Each winner claims their share** by calling `claimPrize(rank)` — funds go straight to their wallet.
9. **Every other lottery on the platform runs completely independently** — a user can be in 5 different lotteries at once, each filling up and drawing on its own separate timeline.

---

## 4. Explicitly Not Locked / Pending Client Decision

These were discussed but are **not yet confirmed or built** — flagged clearly so nothing is assumed:

| Item | Status |
|---|---|
| **DAO Governor + Timelock** (community voting on platform decisions) | Client has indicated preference for admin-only control. Not planned unless this changes. |
| **Gnosis Safe Multisig** (3-of-5 signer wallet replacing single admin key) | Recommended before mainnet launch, not a coding task — a deployment/config step for later. |
| **Referral Contract** (2% reward for referring paying users) | Pending client confirmation on priority/timing. |
| **Rolling Jackpot Rollover** (unclaimed pool carries to next draw) | Pending client confirmation on whether this is core to the product's appeal. Only a placeholder flag (`isJackpot`) exists in `PrizeSchemeRegistry` today — no rollover logic has been built. |

---

## 5. What's Built and Tested vs. What's Still Needed for a Real, Usable Site

**Built and tested (contract layer):**
- `LotteryFactory.sol`, `LotteryCore.sol` (fixed-capacity model), `PrizeSchemeRegistry.sol` — the full locked flow above works correctly with real, passing tests.

**Not yet built (needed to make this usable by a real person):**
- Frontend — the actual website a user interacts with
- Backend — event listening, notifications, caching draw data for fast page loads
- Wiring `TicketNFT` into the purchase flow (optional, pending client interest)
- The Graph subgraph — for fast historical data (past draws, past winners) instead of slow direct contract reads
