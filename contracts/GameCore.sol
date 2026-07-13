// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GameCore
/// @notice One deployed lottery game carrying its FULL game + scheme payload
///         permanently on-chain. Deployed by GameFactory from whatever JSON
///         payload the admin configured — fully dynamic: any rank table
///         (1..20 ranks, AMOUNT or ALLOCATION, any winner ceilings, any
///         claim types), COUNT or DRAW_TIME mode, native or ERC20 currency.
///         The game holds its own funds: ticket proceeds accumulate here,
///         prizes are paid from here, admin withdraws surplus from here.
/// @dev NOT upgradeable — one immutable instance per game.
contract GameCore is VRFConsumerBaseV2Plus, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum GameMode { Count, DrawTime }            // payload gameType: COUNT / DRAW_TIME
    enum PrizeCategory { Amount, Allocation }    // payload prizeCategory
    enum PrizeType { Fixed, Dividend }           // payload prizeType
    enum ClaimType { Auto, HeadOffice, Manual }  // payload claimType
    enum Status { Open, Drawing, SeedReceived, Finalizing, Finalized }
    enum ClaimStatus { None, PendingApproval, Claimable, Claimed }

    struct GameConfig {
        string gameCode;
        string gameName;
        string schemeCode;
        string schemeName;
        GameMode mode;
        uint256 ticketPrice;     // payload mrp in wei / token decimals
        address currency;        // address(0) = native; else ERC20
        uint64 saleStart;
        uint64 saleClose;
        uint64 drawAt;           // DRAW_TIME only; 0 for COUNT
        uint32 maxParticipation; // COUNT only; 0 for DRAW_TIME
    }

    struct RankConfig {
        uint16 rank;
        uint16 maxWinners;       // payload numberOfWinners = ceiling
        PrizeCategory prizeCategory;
        uint128 prizeAmount;     // AMOUNT ranks
        uint16 allocationBps;    // ALLOCATION ranks (50% -> 5000)
        PrizeType prizeType;
        ClaimType claimType;
        string rankDescription;
    }

    struct VRFConfig {
        address vrfCoordinator;
        uint256 subscriptionId;
        bytes32 keyHash;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
    }

    struct WinnerInfo {
        uint16 rankIdx;
        uint128 amount;
        ClaimStatus status;
    }

    // Default winner-count rule (client's stated rule; payload override later)
    uint256 private constant RULE_T1 = 5;   uint256 private constant RULE_C1 = 1;
    uint256 private constant RULE_T2 = 10;  uint256 private constant RULE_C2 = 2;
    uint256 private constant RULE_PCT_BPS = 1000;

    uint256 public immutable gameId;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32  public immutable callbackGasLimit;
    uint16  public immutable requestConfirmations;

    GameConfig public config;
    RankConfig[] private _ranks;

    Status  public status;
    uint256 public ticketsSold;
    uint256 public grossProceeds;
    address[] private _buyers;
    mapping(address => uint256) public ticketsBought;

    uint256 public s_requestId;
    uint256 public drawSeed;

    uint256 public totalWinners;
    uint16[] public winnersPerRank;
    uint256 public nextWinnerIndex;
    uint256 private _remainingPool;
    uint256 public totalPrizeLiability;
    uint256 public totalClaimed;
    mapping(address => WinnerInfo) public winnerInfo;
    mapping(address => bool) public hasWon;
    address[] public winnersList;

    event TicketsPurchased(uint256 indexed gameId, address indexed buyer, uint256 count, uint256 paid);
    event Prefunded(uint256 indexed gameId, address indexed from, uint256 amount);
    event DrawRequested(uint256 indexed gameId, uint256 requestId, uint256 participants);
    event SeedReceived(uint256 indexed gameId, uint256 seed);
    event WinnerRecorded(uint256 indexed gameId, address indexed winner, uint16 rankNumber, uint256 amount, ClaimType claimType);
    event DrawFinalized(uint256 indexed gameId, uint256 totalWinners, uint256 totalLiability);
    event PrizeApproved(uint256 indexed gameId, address indexed winner, address indexed approver);
    event PrizeClaimed(uint256 indexed gameId, address indexed winner, uint256 amount);
    event SurplusWithdrawn(uint256 indexed gameId, address indexed to, uint256 amount);

    error InvalidParam(string reason);
    error SaleNotOpen();
    error SaleWindowPassed();
    error MaxParticipationReached();
    error IncorrectPayment();
    error NotInStatus(Status expected);
    error NoParticipants();
    error DrawNotDue();
    error NothingToFinalize();
    error NotAWinner();
    error NotClaimable();
    error AlreadyClaimed();
    error InvalidVRFRequest();
    error InsufficientSurplus();
    error TransferFailed();

    constructor(
        uint256 _gameId,
        address _admin,
        VRFConfig memory vrf,
        GameConfig memory cfg,
        RankConfig[] memory ranks_
    ) VRFConsumerBaseV2Plus(vrf.vrfCoordinator) {
        if (_admin == address(0)) revert InvalidParam("zero admin");
        if (cfg.ticketPrice == 0) revert InvalidParam("ticketPrice must be > 0");
        if (cfg.saleStart >= cfg.saleClose) revert InvalidParam("saleStart must be < saleClose");
        if (cfg.mode == GameMode.Count) {
            if (cfg.maxParticipation == 0) revert InvalidParam("maxParticipation required for COUNT");
        } else {
            if (cfg.drawAt < cfg.saleClose) revert InvalidParam("drawAt must be >= saleClose");
        }
        if (ranks_.length == 0 || ranks_.length > 20) revert InvalidParam("ranks length 1..20");

        uint256 allocSum;
        for (uint256 i = 0; i < ranks_.length; i++) {
            if (ranks_[i].maxWinners == 0) revert InvalidParam("maxWinners must be >= 1");
            if (ranks_[i].prizeCategory == PrizeCategory.Amount) {
                if (ranks_[i].prizeAmount == 0) revert InvalidParam("prizeAmount required for AMOUNT rank");
            } else {
                if (ranks_[i].allocationBps == 0) revert InvalidParam("allocationBps required for ALLOCATION rank");
                allocSum += ranks_[i].allocationBps;
            }
            _ranks.push(ranks_[i]);
        }
        if (allocSum > 10000) revert InvalidParam("allocation sum exceeds 100%");

        gameId = _gameId;
        subscriptionId = vrf.subscriptionId;
        keyHash = vrf.keyHash;
        callbackGasLimit = vrf.callbackGasLimit;
        requestConfirmations = vrf.requestConfirmations;
        config = cfg;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        status = Status.Open;
    }

    // ─── Buying ──────────────────────────────────────────────────────────────

    /// @notice Buy tickets inside the sale window. Native games: send exact
    ///         value. Token games: approve THIS game contract first, send no value.
    function buyTickets(uint256 count) external payable whenNotPaused nonReentrant {
        if (status != Status.Open) revert NotInStatus(Status.Open);
        if (block.timestamp < config.saleStart) revert SaleNotOpen();
        if (block.timestamp >= config.saleClose) revert SaleWindowPassed();
        if (count == 0) revert InvalidParam("count must be > 0");

        bool isCount = config.mode == GameMode.Count;
        uint256 newParticipant = ticketsBought[msg.sender] == 0 ? 1 : 0;
        if (isCount && _buyers.length + newParticipant > config.maxParticipation) {
            revert MaxParticipationReached();
        }

        uint256 cost = config.ticketPrice * count;
        if (config.currency == address(0)) {
            if (msg.value != cost) revert IncorrectPayment();
        } else {
            if (msg.value != 0) revert IncorrectPayment();
            IERC20(config.currency).safeTransferFrom(msg.sender, address(this), cost);
        }

        if (newParticipant == 1) _buyers.push(msg.sender);
        ticketsBought[msg.sender] += count;
        ticketsSold += count;
        grossProceeds += cost;

        emit TicketsPurchased(gameId, msg.sender, count, cost);

        if (isCount && _buyers.length == config.maxParticipation) {
            _requestDraw();
        }
    }

    /// @notice Optional pre-funding (e.g. AMOUNT games where fixed prizes may
    ///         exceed proceeds). Anyone can top up the game's prize balance.
    function prefundNative() external payable {
        if (config.currency != address(0)) revert IncorrectPayment();
        if (msg.value == 0) revert InvalidParam("zero amount");
        emit Prefunded(gameId, msg.sender, msg.value);
    }

    function prefundToken(uint256 amount) external nonReentrant {
        if (config.currency == address(0)) revert IncorrectPayment();
        if (amount == 0) revert InvalidParam("zero amount");
        emit Prefunded(gameId, msg.sender, amount);
        IERC20(config.currency).safeTransferFrom(msg.sender, address(this), amount);
    }

    // ─── Draw ────────────────────────────────────────────────────────────────

    /// @notice Operator/API trigger. COUNT: after saleClose with >0 buyers, or
    ///         anytime the cap is already reached (fallback). DRAW_TIME: after drawAt.
    function requestDraw() external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (config.mode == GameMode.DrawTime) {
            if (block.timestamp < config.drawAt) revert DrawNotDue();
        } else {
            bool capReached = _buyers.length >= config.maxParticipation;
            if (!capReached && block.timestamp < config.saleClose) revert DrawNotDue();
        }
        _requestDraw();
    }

    function _requestDraw() internal {
        if (status != Status.Open) revert NotInStatus(Status.Open);
        if (_buyers.length == 0) revert NoParticipants();

        status = Status.Drawing;
        s_requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );
        emit DrawRequested(gameId, s_requestId, _buyers.length);
    }

    /// @dev Callback stores ONLY the seed; winners are computed in batched
    ///      finalizeDraw() calls so callback gas can never be exceeded.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        if (requestId != s_requestId) revert InvalidVRFRequest();
        if (status != Status.Drawing) revert NotInStatus(Status.Drawing);
        drawSeed = randomWords[0];
        status = Status.SeedReceived;
        emit SeedReceived(gameId, drawSeed);
    }

    // ─── Finalization ────────────────────────────────────────────────────────

    /// @notice Batched, deterministic winner computation from the stored seed.
    ///         Callable by anyone; outcome is fixed once the seed lands.
    function finalizeDraw(uint256 maxThisCall) external nonReentrant {
        if (status != Status.SeedReceived && status != Status.Finalizing)
            revert NotInStatus(Status.SeedReceived);
        if (maxThisCall == 0) revert InvalidParam("maxThisCall must be > 0");

        if (status == Status.SeedReceived) {
            _initFinalization();
            status = Status.Finalizing;
        }

        uint256 end = nextWinnerIndex + maxThisCall;
        if (end > totalWinners) end = totalWinners;
        if (nextWinnerIndex >= end) revert NothingToFinalize();

        for (uint256 w = nextWinnerIndex; w < end; w++) {
            _pickWinner(w);
        }
        nextWinnerIndex = end;

        if (nextWinnerIndex == totalWinners) {
            status = Status.Finalized;
            emit DrawFinalized(gameId, totalWinners, totalPrizeLiability);
        }
    }

    function _initFinalization() internal {
        uint256 p = _buyers.length;

        uint256 w;
        if (p <= RULE_T1) w = RULE_C1;
        else if (p <= RULE_T2) w = RULE_C2;
        else {
            w = (p * RULE_PCT_BPS) / 10000;
            if (w < RULE_C2) w = RULE_C2;
        }

        uint256 slotCap;
        for (uint256 i = 0; i < _ranks.length; i++) slotCap += _ranks[i].maxWinners;
        if (w > slotCap) w = slotCap;
        if (w > p) w = p;

        totalWinners = w;
        _remainingPool = ticketsSold;

        uint256 left = w;
        for (uint256 i = 0; i < _ranks.length; i++) {
            uint16 take = left >= _ranks[i].maxWinners ? _ranks[i].maxWinners : uint16(left);
            winnersPerRank.push(take);
            left -= take;
        }
    }

    function _pickWinner(uint256 winnerIndex) internal {
        uint256 pick = uint256(keccak256(abi.encode(drawSeed, winnerIndex))) % _remainingPool;

        uint256 cumulative;
        address selected;
        uint256 buyerCount = _buyers.length;
        for (uint256 i = 0; i < buyerCount; i++) {
            address b = _buyers[i];
            if (hasWon[b]) continue; // one wallet wins only once
            cumulative += ticketsBought[b];
            if (pick < cumulative) { selected = b; break; }
        }

        (uint16 rankIdx, uint16 rankNumber) = _rankForWinnerIndex(winnerIndex);
        uint128 amount = _prizeForRank(rankIdx);
        ClaimType ct = _ranks[rankIdx].claimType;

        hasWon[selected] = true;
        _remainingPool -= ticketsBought[selected];
        winnersList.push(selected);
        winnerInfo[selected] = WinnerInfo({
            rankIdx: rankIdx,
            amount: amount,
            status: ct == ClaimType.Auto ? ClaimStatus.Claimable : ClaimStatus.PendingApproval
        });
        totalPrizeLiability += amount;

        emit WinnerRecorded(gameId, selected, rankNumber, amount, ct);
    }

    function _rankForWinnerIndex(uint256 winnerIndex) internal view returns (uint16, uint16) {
        uint256 cum;
        for (uint256 i = 0; i < winnersPerRank.length; i++) {
            cum += winnersPerRank[i];
            if (winnerIndex < cum) return (uint16(i), _ranks[i].rank);
        }
        revert InvalidParam("winner index out of range");
    }

    function _prizeForRank(uint16 rankIdx) internal view returns (uint128) {
        RankConfig storage r = _ranks[rankIdx];
        uint256 n = winnersPerRank[rankIdx];
        if (r.prizeCategory == PrizeCategory.Amount) {
            if (r.prizeType == PrizeType.Fixed) return r.prizeAmount;
            return uint128(uint256(r.prizeAmount) / n);
        }
        return uint128((grossProceeds * r.allocationBps) / 10000 / n);
    }

    // ─── Claims ──────────────────────────────────────────────────────────────

    /// @notice Admin/API approval step for HEAD_OFFICE and MANUAL ranks.
    function approvePrize(address winner) external onlyRole(OPERATOR_ROLE) {
        WinnerInfo storage info = winnerInfo[winner];
        if (info.status == ClaimStatus.None) revert NotAWinner();
        if (info.status != ClaimStatus.PendingApproval) revert NotClaimable();
        info.status = ClaimStatus.Claimable;
        emit PrizeApproved(gameId, winner, msg.sender);
    }

    /// @notice Winner pulls their prize from the game's own balance.
    function claimPrize() external nonReentrant {
        WinnerInfo storage info = winnerInfo[msg.sender];
        if (info.status == ClaimStatus.None) revert NotAWinner();
        if (info.status == ClaimStatus.Claimed) revert AlreadyClaimed();
        if (info.status != ClaimStatus.Claimable) revert NotClaimable();

        info.status = ClaimStatus.Claimed;
        totalClaimed += info.amount;
        emit PrizeClaimed(gameId, msg.sender, info.amount);

        if (config.currency == address(0)) {
            (bool ok,) = msg.sender.call{value: info.amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(config.currency).safeTransfer(msg.sender, info.amount);
        }
    }

    // ─── Surplus (house) withdrawal ──────────────────────────────────────────

    /// @notice After finalization the admin may withdraw anything above the
    ///         still-unclaimed prize liability — never winners' money.
    function withdrawSurplus(address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert InvalidParam("zero recipient");
        if (status != Status.Finalized) revert NotInStatus(Status.Finalized);

        uint256 unclaimed = totalPrizeLiability - totalClaimed;
        uint256 balance = config.currency == address(0)
            ? address(this).balance
            : IERC20(config.currency).balanceOf(address(this));
        if (amount == 0 || amount > balance - unclaimed) revert InsufficientSurplus();

        emit SurplusWithdrawn(gameId, to, amount);

        if (config.currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(config.currency).safeTransfer(to, amount);
        }
    }

    // ─── Pause / Views (everything the UI needs) ─────────────────────────────

    function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
    function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }

    function getRanks() external view returns (RankConfig[] memory) { return _ranks; }
    function getRankCount() external view returns (uint256) { return _ranks.length; }
    function participantCount() external view returns (uint256) { return _buyers.length; }
    function getBuyer(uint256 i) external view returns (address) { return _buyers[i]; }
    function getWinnerCount() external view returns (uint256) { return winnersList.length; }
    function getWinners() external view returns (address[] memory) { return winnersList; }
    function prizeBalance() external view returns (uint256) {
        return config.currency == address(0)
            ? address(this).balance
            : IERC20(config.currency).balanceOf(address(this));
    }
}
