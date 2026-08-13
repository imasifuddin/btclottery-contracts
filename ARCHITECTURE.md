# btclottery.io — Contract Architecture (Source of Truth)

This document describes the architecture **as currently built and deployed**.
It is the single reference for how the on-chain layer works and why it is
shaped this way. When the client changes a requirement, update the relevant
section here rather than assuming history.

> **Naming note:** earlier iterations used `Lottery*` contracts (a timer +
> refund model, then a fixed-capacity model) plus a separate on-chain scheme
> registry and treasury. **Those are superseded and deleted from the working
> tree** — see [Section 9](#9-superseded-history). The live design is the
> **payload-driven `Game*` model** described below.

---

## 1. The Locked Requirement

The client (btclottery.io) runs an admin portal where staff define **schemes**
(how many winners and what share each gets) and **games** (an individual
contest: ticket price, currency, sale window, how the draw is triggered). Both
live in the **client's own database**.

When an admin clicks **"Push to Blockchain"**, the portal's backend POSTs a
single JSON payload — the game plus its full scheme (prize ranks) — to **our
API**. Our API converts it and sends **one transaction** to the `GameFactory`,
which deploys a fresh `GameCore` instance carrying the **entire payload
permanently on-chain**.

Confirmed, locked behaviors:

- Each game defines its own trigger: **COUNT** (draw fires automatically the
  moment a fixed participant cap fills) or **DRAW_TIME** (draw after a set
  timestamp).
- **No refund mechanism** — a COUNT game that fills always completes; an
  underfilled COUNT game can still be drawn by the operator after sale close
  with whoever joined.
- **Multiple winners per game** via a dynamic rank table — 1 winner or many
  ranked tiers with different prize shares.
- **Multiple games run simultaneously and independently.**
- Wallet connection happens at the point of buying a ticket, not to browse.
- **Admin-only control** — no DAO/community voting.

---

## 2. Architecture Principles (LOCKED)

- **Payload-driven, no on-chain scheme registry.** Schemes are not stored in a
  shared registry contract; each game's full scheme travels *inside its own
  payload* and is embedded in that game at deploy time. (An earlier
  `PrizeSchemeRegistry` was deleted at the client's direction.)
- **No central treasury.** Each `GameCore` holds its **own** funds — ticket
  proceeds accumulate in it, prizes are paid from it, the admin withdraws
  surplus from it. (An earlier `Treasury.sol` was removed at client request;
  the client "will come up with another idea" later.)
- **Fully dynamic.** Any scheme shape (1–20 ranks, AMOUNT or ALLOCATION, any
  winner ceilings, any claim types), COUNT or DRAW_TIME mode, native or ERC20
  currency — all deploy with **zero code changes**.
- **Two settlement modes**, fixed per game at creation:
  - **OnChain** — buyers pay the contract from their own wallet; the game holds
    the prize pool and winners claim from it.
  - **OffChain (registry)** — the current mode for all new games. Buyers pay by
    **card/UPI** through the client's payment gateway; our API then calls
    `registerEntryFor` to record the entry. Proceeds accrue *notionally* so
    prize amounts are still computed and published, but **the contract never
    holds funds** and the admin settles prizes off-chain. `buyTickets`,
    `prefund*` and `claimPrize` all revert on these games — deliberately, so
    value can never be sent to a game with no payout path.
  Both modes share the same participant list, capacity rule, VRF draw and
  winner selection.
- **`GameFactory` is UUPS-upgradeable** (its proxy is the permanent address).
  `GameCore` bytecode is embedded in the factory, so changing game logic means:
  edit `GameCore` → recompile → upgrade the factory proxy. New games use the
  new logic.
- **Deployed games are immutable forever.** `GameCore` is **not** upgradeable
  and holds user funds directly — a deliberate trust guarantee to players.
- **SPDX license: MIT** (locked).

---

## 3. Contract Lineup (only these two)

### `contracts/contracts/GameCore.sol` — one instance per game

Not upgradeable. Holds its own funds. Carries its full game + scheme payload.

**`GameConfig` struct:** `gameCode`, `gameName`, `schemeCode`, `schemeName`,
`mode` (0 = Count, 1 = DrawTime), `ticketPrice` (18-decimal fixed point, in
whatever unit `currencySymbol` names), `currency` (`address(0)` = native, else
ERC20 — OnChain games only), `saleStart` / `saleClose` / `drawAt` (unix
`uint64`), `maxParticipation` (`uint32`, COUNT only), `currencySymbol` (display
unit: `"INR"`, `"ETH"`, …), `settlementMode` (0 = OnChain, 1 = OffChain).

The last two were **appended** in v2, so the `config()` tuple indices the
client's UI already reads (0–10) are unchanged.

**Registering an off-chain purchase —
`registerEntryFor(participant, count, externalRef)`:** operator-only, OffChain
games only. Applies the same status/window/capacity rules as a wallet purchase,
credits the participant, accrues `ticketPrice × count` notionally, and fires the
auto-draw when the final seat is taken. `externalRef` (keccak256 of the payment
`txnId`) is stored in `entries[]`, which serves as both the **duplicate guard**
— making retries safe, since the same purchase can never be recorded twice —
and the buyer's own **verification lookup**.

**`RankConfig` struct:** `rank`, `maxWinners` (a **ceiling**, not a target),
`prizeCategory` (0 = Amount, 1 = Allocation), `prizeAmount` (`uint128`, AMOUNT
ranks), `allocationBps` (`uint16`, ALLOCATION ranks; 50% = 5000), `prizeType`
(0 = Fixed, 1 = Dividend), `claimType` (0 = Auto, 1 = HeadOffice, 2 = Manual),
`rankDescription`.

**Enums:** `Status` (0 Open, 1 Drawing, 2 SeedReceived, 3 Finalizing,
4 Finalized); `ClaimStatus` (0 None, 1 PendingApproval, 2 Claimable, 3 Claimed).

**Buying — `buyTickets(count)` (payable):** native games send exact value;
ERC20 games require the user to `approve` the **game** contract first, then
send zero value. COUNT games **auto-trigger the VRF draw inside the buy tx that
fills `maxParticipation`** — the cap counts **unique wallets**, not tickets, so
repeat buys by an existing participant don't consume a slot.

**Draw — `requestDraw()` (OPERATOR_ROLE):** DRAW_TIME games after `drawAt`;
COUNT games after `saleClose` if the cap never filled (proceeds with whoever
joined, must be > 0 participants).

**Randomness (Chainlink VRF v2.5):** the VRF callback stores **only** the seed
(`drawSeed`) and moves to `SeedReceived`. Winner computation happens separately
in **batched `finalizeDraw(maxThisCall)` calls, callable by anyone** (fully
deterministic from the seed). This decouples winner selection from VRF callback
gas limits — client payloads can carry hundreds of winner slots.

**Stuck-draw recovery — `retryDraw()`:** operator-only, permitted once a VRF
request has gone unanswered for `DRAW_RETRY_DELAY` (1 hour). Without it a
request Chainlink never fulfils would freeze the game permanently, since
`requestDraw` only works from `Open` — participants would be stranded with no
path to a result. The participant list is untouched across a retry, so fairness
is preserved, and a late fulfilment of the abandoned request is ignored because
`fulfillRandomWords` only accepts the current `s_requestId`.

> **Why this matters in practice.** Chainlink reserves subscription funds
> against the *declared* `callbackGasLimit` priced at the gas lane's maximum,
> not against actual usage. An oversized limit therefore demands a large idle
> LINK balance, and a subscription that falls below it leaves requests pending
> until they expire. Our callback only stores a seed (~50k gas), so the limit
> should be set accordingly — see `GameFactory.setVrfConfig`.

**Winner rule (hardcoded defaults; may become payload-configurable later):**
for `P` unique participants — `P ≤ 5` → 1 winner; `P ≤ 10` → 2; else
`floor(10% of P)`, minimum 2. Capped by total rank slots and by `P`. Ranks fill
**top-down**. **One wallet wins at most once per game** (`hasWon`).

**Prize math:**
- AMOUNT + Fixed → `prizeAmount` per winner.
- AMOUNT + Dividend → `prizeAmount ÷ actual winners in that rank`.
- ALLOCATION (either prize type) → `grossProceeds × allocationBps / 10000 ÷
  actual winners in that rank`.
- Sum of `allocationBps` is validated ≤ 10000; any remainder + rounding dust
  becomes house surplus.

**Claims:** Auto ranks are instantly `Claimable` after finalize; HeadOffice and
Manual ranks sit at `PendingApproval` until `approvePrize(winner)`
(OPERATOR_ROLE). Winners pull funds via `claimPrize()` (pull-payment from the
game's own balance).

**Admin funds:** `withdrawSurplus(to, amount)` (DEFAULT_ADMIN_ROLE, only after
`Finalized`, only up to `balance − unclaimed liability`).
`prefundNative()` / `prefundToken()` let anyone top up AMOUNT games whose fixed
prizes may exceed proceeds.

**UI views:** `config`, `getRanks()`, `participantCount()`, `ticketsSold`,
`grossProceeds`, `status`, `getWinners()`, `winnerInfo(addr)`, `prizeBalance()`.

**Known quirk:** because the factory deploys each game, the Chainlink-base
`owner` of each `GameCore` is the **factory address** — harmless and expected.

### `contracts/contracts/GameFactory.sol` — UUPS upgradeable

- `initialize(InitParams{ admin, vrfCoordinator, vrfSubscriptionId, vrfKeyHash,
  vrfCallbackGasLimit, vrfRequestConfirmations })`.
- `createGame(cfg, ranks, gameAdmin)` — GAME_CREATOR_ROLE; rejects a duplicate
  `gameCode`; deploys a `GameCore`; indexes it by id / address / gameCode;
  emits `GameCreated(gameId, gameAddress, gameCode, schemeCode, currency,
  creator)`.
- `setVrfConfig(subscriptionId, keyHash, callbackGasLimit, requestConfirmations)`
  — DEFAULT_ADMIN_ROLE. Applies to games created from then on; deployed games
  keep the settings they were born with, which are immutable in each `GameCore`.
  Chiefly used to keep `callbackGasLimit` close to real usage so the VRF
  subscription is not forced to hold a large idle reserve.
- Views: `getAllGames()`, `getGame(id)`, `getGameByCode(code)`,
  `getGameCount()`.

`contracts/contracts/test/MockUSDT.sol` exists only to exercise the ERC20 path
in tests. `Counter.sol` is leftover Hardhat scaffold.

---

## 4. End-to-End Flow

1. Admin configures a game + scheme in the client's portal → clicks **Push to
   Blockchain**.
2. Portal POSTs the payload to our API (`POST /api/v1/games/push`).
3. API validates + converts the payload and calls `createGame` on the factory
   (one tx), then auto-registers the new game as a VRF consumer.
4. Players `buyTickets(count)` directly from their own wallets during the sale
   window.
5. Draw fires: **COUNT** auto-draws when the cap fills; **DRAW_TIME** (or an
   underfilled COUNT) is triggered by the operator via the API.
6. Chainlink VRF returns randomness → the game stores the seed.
7. Anyone (in practice, the API) calls `finalizeDraw` in batches until winners
   are computed and the game is `Finalized`.
8. Auto prizes are immediately claimable; HeadOffice/Manual prizes become
   claimable after the operator `approvePrize`s them.
9. Winners `claimPrize()` from their own wallets. The admin may
   `withdrawSurplus` of anything above unclaimed liability.

---

## 5. Live Sepolia Deployment (chainId 11155111)

| Item | Value |
|---|---|
| GameFactory **proxy** (the permanent address) | `0xb7132A1139d552373a8BE2795693417Ea8fDeC65` |
| Implementation | `0x738a10760207a9B42169877fF48fcCE36F0c3c02` |
| Operator wallet (all roles) | `0xb42718A49DC91C5653f0Be53bC73df51Fb8F2729` |
| VRF Coordinator (Sepolia) | `0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B` |
| VRF keyHash | `0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae` |
| VRF subscription ID | `75292865757511940771629505450063568836747134001638153062922999998674938286392` |
| callbackGasLimit / confirmations | 2,000,000 / 3 |
| Demo game GAME0011 | `0x8bAFfc6B7FE2187c765a4701cEc68C96B189640d` |

All three (proxy, implementation, GAME0011) are **verified on Etherscan**;
later games auto-verify by bytecode matching. Each new game is auto-added as a
VRF consumer by the API (manual fallback at vrf.chain.link).

> **Never delete `ignition/deployments/`** — it is the deployment journal and
> underpins Etherscan verification. Verify immediately after any deploy with
> `npx hardhat ignition verify chain-11155111 --network sepolia` (the
> `--network` flag is required or it targets chainId 31337).

---

## 6. Tests

`test/GameCore.ts` + `test/GameFactory.ts` — **35 passing** (plus 3 Solidity
`Counter` tests from the scaffold). Coverage includes: the client's exact
payload, a structurally different payload (dynamism proof), the sale window,
COUNT cap + auto-draw, DRAW_TIME, the winner rule (5→1, 8→2, 30→3 with exact
prize math), batched finalize, all claim types, prefund + surplus, a full ERC20
cycle, and a UUPS upgrade that preserves the game index.

Registry-mode coverage: notional proceeds in rupees, duplicate `txnId`
rejection, one `userId` counting as a single participant across repeat
purchases, cap-fill auto-draw, blocked buying/prefunding/claiming, operator-only
access, sale-window enforcement, a full 5-buyer INR cycle (winner correctly owed
₹125 of a ₹250 pool), and a DRAW_TIME registry game.

### ⚠️ Contract size

`GameFactory` embeds GameCore's entire creation bytecode, so it sits at
**24,416 bytes against the hard 24,576-byte EIP-170 limit** — about 160 bytes
of headroom. The optimizer runs at `runs: 1` to buy that room, and
`registerEntriesBatch` was dropped for the same reason (batching is only needed
at volumes we do not yet have).

**Any further addition to `GameCore` must be size-checked first.** If more room
is genuinely needed, the structural fix is to stop embedding GameCore in the
factory and deploy games as minimal-proxy clones instead — a real refactor, not
a tweak.

---

## 7. Locked Working Defaults (client may revise; documented as defaults)

1. **MANUAL** claim type currently behaves exactly like **HEAD_OFFICE**
   (requires operator approval).
2. The **winner rule is hardcoded** (10% / ≤10→2 / ≤5→1). Payload fields for it
   don't exist yet; when the client adds them, thread through `GameConfig` +
   `convert.ts` + a factory upgrade (old games unaffected).
3. COUNT games whose sale closes before the cap fills: the operator may draw
   with any number of buyers > 0.
4. `finalizeDraw` is batched to handle large winner counts (payloads have
   carried up to ~561 winner slots).
5. Allocation sums ≤ 100%; the remainder + rounding dust is house surplus. If
   the client always sends exactly 100%, the house receives nothing on those
   games — **flagged to the client**.

---

## 8. Pending / Not Yet Locked

| Item | Status |
|---|---|
| **Custodial buy flow** (backend executes buys on behalf of users) | ⚠️ Awaiting client clarification. If the operator key signs buys, tickets would belong on-chain to the operator wallet, breaking one-wallet-wins-once / `winnerInfo` / `claimPrize`. Two valid resolutions: (a) user-wallet signing (no contract change), or (b) a true custodial model requiring a new `buyTicketsFor(user, count)` + factory upgrade + new games only. **Do not implement until the client answers who signs, who pays, who claims.** |
| Winner-rule payload fields | Pending client decision (would become configurable). |
| MANUAL vs HEAD_OFFICE distinct semantics | Pending client decision. |
| 100%-allocation house-share | Pending client decision (see §7.5). |
| DAO Governor / Timelock | Skipped — admin-only control confirmed. |
| Gnosis Safe multisig | Deferred to mainnet configuration. |
| Referral rewards / rolling jackpot | Pending client interest. |

---

## 9. Superseded History

Earlier iterations, **deleted from the working tree** but preserved in git
history (contracts repo, commits ≤ `4f09dac`) — do not resurrect without a
client requirement:

- `LotteryFactory` / `LotteryCore` — timer + refund model, then a
  fixed-capacity model. Replaced by the payload-driven `Game*` model.
- `PrizeSchemeRegistry` — a UUPS on-chain scheme registry. Replaced by
  embedding the scheme in each game's payload.
- `Treasury.sol` — a central fund vault. Removed; each game holds its own funds.
- `BTCLPToken` (ERC20Votes), `TicketNFT`, `RaffleCore` (Merkle-whitelist
  donated-prize raffles) — built then set aside; not part of the locked flow.

Stale TypeChain bindings for some of these names still sit in
`contracts/types/` as generated leftovers; they do not reflect the deployed
contracts.
