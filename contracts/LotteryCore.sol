// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PrizeSchemeRegistry} from "./PrizeSchemeRegistry.sol";

/// @title LotteryCore
/// @notice A single lottery draw instance deployed by LotteryFactory.
///         Supports multi-tier prize distribution via a referenced
///         PrizeSchemeRegistry scheme. Handles ticket sales, prize pool
///         accumulation, Chainlink VRF V2.5 multi-winner selection,
///         per-rank prize claims, refunds if minTickets not met, and
///         Chainlink Automation for hands-free draw/refund triggering.
/// @dev NOT upgradeable. CEI pattern on all fund movements. ReentrancyGuard
///      unconditional since this contract holds user funds.
contract LotteryCore is
    VRFConsumerBaseV2Plus,
    AutomationCompatibleInterface,
    ReentrancyGuard,
    Pausable,
    AccessControl
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");

    // ─── Status ──────────────────────────────────────────────────────────────

    enum LotteryStatus { Created, Open, Drawing, Completed, Refunding }

    // ─── VRF Config ──────────────────────────────────────────────────────────

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32  public immutable callbackGasLimit;
    uint16  public immutable requestConfirmations;
    uint256 public s_requestId;

    // ─── Automation Config ───────────────────────────────────────────────────

    /// @notice Address of the Chainlink Automation Forwarder authorized to
    ///         call performUpkeep(). Zero until set by an admin after the
    ///         upkeep is registered (the Forwarder address is only known
    ///         post-registration). While zero, only OPERATOR_ROLE can call
    ///         performUpkeep — Automation is effectively opt-in per draw.
    address public automationForwarder;

    // ─── Prize Scheme ────────────────────────────────────────────────────────

    PrizeSchemeRegistry public immutable prizeSchemeRegistry;
    uint256 public immutable schemeId;
    uint256 public immutable tierCount;

    // ─── Lottery State ───────────────────────────────────────────────────────

    address public immutable factory;
    uint256 public immutable lotteryId;

    LotteryStatus public status;
    uint256 public ticketPrice;
    uint256 public maxTickets;
    uint256 public minTickets;
    uint256 public ticketsSold;
    uint256 public prizePool;
    uint256 public drawTime;
    address public feeRecipient;

    mapping(uint256 => address) public winners;
    mapping(uint256 => bool) public rankClaimed;
    mapping(address => uint256) public ticketsBought;
    address[] private _buyers;
    mapping(address => bool) public refundClaimed;

    // ─── Events ──────────────────────────────────────────────────────────────

    event LotteryOpened(uint256 indexed lotteryId, uint256 drawTime, uint256 ticketPrice);
    event TicketsPurchased(uint256 indexed lotteryId, address indexed buyer, uint256 count, uint256 totalPaid);
    event DrawRequested(uint256 indexed lotteryId, uint256 requestId, uint256 ticketsSold);
    event WinnerSelected(uint256 indexed lotteryId, uint256 indexed rank, address indexed winner, uint256 prize);
    event PrizeClaimed(uint256 indexed lotteryId, uint256 indexed rank, address indexed winner, uint256 amount);
    event RefundTriggered(uint256 indexed lotteryId, uint256 ticketsSold);
    event RefundClaimed(uint256 indexed lotteryId, address indexed buyer, uint256 amount);
    event AutomationForwarderSet(address indexed forwarder);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotOpen();
    error NotCompleted();
    error NotRefunding();
    error DrawTimeNotReached();
    error DrawTimeAlreadyPassed();
    error MinTicketsNotMet();
    error MinTicketsMet();
    error SoldOut();
    error IncorrectPayment();
    error NoTicketsPurchased();
    error AlreadyClaimed();
    error NotWinner();
    error InvalidParam(string reason);
    error TransferFailed();
    error InvalidVRFRequest();
    error InvalidRank();
    error SchemeInactiveAtCreation();
    error NotAuthorizedForUpkeep();
    error UpkeepNotNeeded();

    // ─── Constructor ─────────────────────────────────────────────────────────

    struct VRFConfig {
        address vrfCoordinator;
        uint256 subscriptionId;
        bytes32 keyHash;
        uint32  callbackGasLimit;
        uint16  requestConfirmations;
    }

    struct DrawConfig {
        address factory;
        uint256 lotteryId;
        address admin;
        uint256 ticketPrice;
        uint256 maxTickets;
        uint256 minTickets;
        uint256 drawTime;
        address feeRecipient;
        address prizeSchemeRegistry;
        uint256 schemeId;
    }

    constructor(VRFConfig memory vrf, DrawConfig memory draw)
        VRFConsumerBaseV2Plus(vrf.vrfCoordinator)
    {
        if (draw.factory == address(0))      revert ZeroAddress();
        if (draw.admin == address(0))        revert ZeroAddress();
        if (draw.feeRecipient == address(0)) revert ZeroAddress();
        if (draw.prizeSchemeRegistry == address(0)) revert ZeroAddress();
        if (draw.ticketPrice == 0)           revert InvalidParam("ticketPrice must be > 0");
        if (draw.maxTickets == 0)            revert InvalidParam("maxTickets must be > 0");
        if (draw.minTickets == 0)            revert InvalidParam("minTickets must be > 0");
        if (draw.minTickets > draw.maxTickets) revert InvalidParam("minTickets > maxTickets");
        if (draw.drawTime <= block.timestamp) revert InvalidParam("drawTime must be in future");
        if (vrf.callbackGasLimit == 0)       revert InvalidParam("callbackGasLimit must be > 0");

        PrizeSchemeRegistry registry = PrizeSchemeRegistry(draw.prizeSchemeRegistry);
        if (!registry.isSchemeActive(draw.schemeId)) revert SchemeInactiveAtCreation();

        subscriptionId        = vrf.subscriptionId;
        keyHash                = vrf.keyHash;
        callbackGasLimit       = vrf.callbackGasLimit;
        requestConfirmations   = vrf.requestConfirmations;

        factory       = draw.factory;
        lotteryId     = draw.lotteryId;
        ticketPrice   = draw.ticketPrice;
        maxTickets    = draw.maxTickets;
        minTickets    = draw.minTickets;
        drawTime      = draw.drawTime;
        feeRecipient  = draw.feeRecipient;

        prizeSchemeRegistry = registry;
        schemeId            = draw.schemeId;
        tierCount           = registry.getTierCount(draw.schemeId);

        _grantRole(DEFAULT_ADMIN_ROLE, draw.admin);
        _grantRole(OPERATOR_ROLE, draw.admin);
        _grantRole(PAUSER_ROLE, draw.admin);

        status = LotteryStatus.Open;
        emit LotteryOpened(draw.lotteryId, draw.drawTime, draw.ticketPrice);
    }

    // ─── Ticket Purchase ─────────────────────────────────────────────────────

    function buyTickets(uint256 count)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (status != LotteryStatus.Open)      revert NotOpen();
        if (block.timestamp >= drawTime)       revert DrawTimeAlreadyPassed();
        if (count == 0)                        revert InvalidParam("count must be > 0");
        if (ticketsSold + count > maxTickets)  revert SoldOut();
        if (msg.value != ticketPrice * count)  revert IncorrectPayment();

        if (ticketsBought[msg.sender] == 0) {
            _buyers.push(msg.sender);
        }
        ticketsBought[msg.sender] += count;
        ticketsSold               += count;
        prizePool                 += msg.value;

        emit TicketsPurchased(lotteryId, msg.sender, count, msg.value);
    }

    // ─── Draw ────────────────────────────────────────────────────────────────

    /// @notice Request winner selection via Chainlink VRF. Callable manually
    ///         by an operator, or automatically via performUpkeep().
    function requestDraw()
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        _requestDraw();
    }

    function _requestDraw() internal {
        if (status != LotteryStatus.Open)  revert NotOpen();
        if (block.timestamp < drawTime)    revert DrawTimeNotReached();
        if (ticketsSold < minTickets)      revert MinTicketsNotMet();

        status = LotteryStatus.Drawing;

        s_requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              keyHash,
                subId:                subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:     callbackGasLimit,
                numWords:             uint32(tierCount),
                extraArgs:            VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                )
            })
        );

        emit DrawRequested(lotteryId, s_requestId, ticketsSold);
    }

    /// @notice Chainlink VRF callback. Selects `tierCount` distinct winners
    ///         using sequential remove-after-pick weighted selection so no
    ///         address can win more than one rank.
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        if (requestId != s_requestId)        revert InvalidVRFRequest();
        if (status != LotteryStatus.Drawing) revert NotOpen();

        uint256 buyerCount = _buyers.length;
        uint256[] memory weights = new uint256[](buyerCount);
        for (uint256 i = 0; i < buyerCount; i++) {
            weights[i] = ticketsBought[_buyers[i]];
        }

        uint256 remainingTicketsPool = ticketsSold;
        uint256 ranksToDraw = tierCount < buyerCount ? tierCount : buyerCount;

        for (uint256 rank = 0; rank < ranksToDraw; rank++) {
            uint256 pick = randomWords[rank] % remainingTicketsPool;
            uint256 cumulative = 0;
            uint256 selectedIndex = type(uint256).max;

            for (uint256 i = 0; i < buyerCount; i++) {
                if (weights[i] == 0) continue;
                cumulative += weights[i];
                if (pick < cumulative) {
                    selectedIndex = i;
                    break;
                }
            }

            address selectedWinner = _buyers[selectedIndex];
            winners[rank] = selectedWinner;

            remainingTicketsPool -= weights[selectedIndex];
            weights[selectedIndex] = 0;

            PrizeSchemeRegistry.PrizeScheme memory scheme =
                prizeSchemeRegistry.getScheme(schemeId);
            uint256 prize = (prizePool * scheme.tierBps[rank]) / 10000;

            emit WinnerSelected(lotteryId, rank, selectedWinner, prize);
        }

        status = LotteryStatus.Completed;

        PrizeSchemeRegistry.PrizeScheme memory feeScheme =
            prizeSchemeRegistry.getScheme(schemeId);
        uint256 fee = (prizePool * feeScheme.feeBps) / 10000;
        if (fee > 0) {
            (bool feeSuccess,) = feeRecipient.call{value: fee}("");
            if (!feeSuccess) revert TransferFailed();
        }
    }

    // ─── Prize Claim ─────────────────────────────────────────────────────────

    function claimPrize(uint256 rank) external nonReentrant {
        if (status != LotteryStatus.Completed) revert NotCompleted();
        if (rank >= tierCount)                 revert InvalidRank();
        if (msg.sender != winners[rank])       revert NotWinner();
        if (rankClaimed[rank])                 revert AlreadyClaimed();

        rankClaimed[rank] = true;

        PrizeSchemeRegistry.PrizeScheme memory scheme =
            prizeSchemeRegistry.getScheme(schemeId);
        uint256 prize = (prizePool * scheme.tierBps[rank]) / 10000;

        emit PrizeClaimed(lotteryId, rank, msg.sender, prize);

        (bool success,) = msg.sender.call{value: prize}("");
        if (!success) revert TransferFailed();
    }

    // ─── Refunds ─────────────────────────────────────────────────────────────

    /// @notice Trigger refund mode. Callable manually by an operator, or
    ///         automatically via performUpkeep().
    function triggerRefund()
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        _triggerRefund();
    }

    function _triggerRefund() internal {
        if (status != LotteryStatus.Open)  revert NotOpen();
        if (block.timestamp < drawTime)    revert DrawTimeNotReached();
        if (ticketsSold >= minTickets)     revert MinTicketsMet();

        status = LotteryStatus.Refunding;
        emit RefundTriggered(lotteryId, ticketsSold);
    }

    function claimRefund() external nonReentrant {
        if (status != LotteryStatus.Refunding) revert NotRefunding();
        if (ticketsBought[msg.sender] == 0)    revert NoTicketsPurchased();
        if (refundClaimed[msg.sender])         revert AlreadyClaimed();

        uint256 refundAmount = ticketsBought[msg.sender] * ticketPrice;
        refundClaimed[msg.sender] = true;

        emit RefundClaimed(lotteryId, msg.sender, refundAmount);

        (bool success,) = msg.sender.call{value: refundAmount}("");
        if (!success) revert TransferFailed();
    }

    // ─── Chainlink Automation ────────────────────────────────────────────────

    /// @notice Sets the authorized Automation Forwarder address. Only callable
    ///         once by an admin, after registering this contract as an upkeep
    ///         in the Chainlink Automation App (the Forwarder address is only
    ///         known post-registration).
    function setAutomationForwarder(address forwarder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (forwarder == address(0)) revert ZeroAddress();
        automationForwarder = forwarder;
        emit AutomationForwarderSet(forwarder);
    }

    /// @notice Off-chain simulated by Chainlink Automation nodes every block.
    ///         Returns true when either a draw or a refund should be triggered.
    /// @dev View-only, gas cost irrelevant (never executed on-chain directly).
    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (status != LotteryStatus.Open || block.timestamp < drawTime) {
            return (false, bytes(""));
        }

        if (ticketsSold >= minTickets) {
            return (true, abi.encode(true)); // true = requestDraw path
        } else {
            return (true, abi.encode(false)); // false = triggerRefund path
        }
    }

    /// @notice Executed on-chain by the Automation Forwarder when checkUpkeep
    ///         returns true. Re-validates all conditions independently of
    ///         checkUpkeep's result, per Chainlink Automation best practice.
    function performUpkeep(bytes calldata performData) external override nonReentrant {
        if (automationForwarder != address(0)) {
            if (msg.sender != automationForwarder && !hasRole(OPERATOR_ROLE, msg.sender)) {
                revert NotAuthorizedForUpkeep();
            }
        } else {
            if (!hasRole(OPERATOR_ROLE, msg.sender)) revert NotAuthorizedForUpkeep();
        }

        if (status != LotteryStatus.Open || block.timestamp < drawTime) {
            revert UpkeepNotNeeded();
        }

        bool shouldDraw = abi.decode(performData, (bool));

        if (shouldDraw) {
            if (ticketsSold < minTickets) revert UpkeepNotNeeded();
            _requestDraw();
        } else {
            if (ticketsSold >= minTickets) revert UpkeepNotNeeded();
            _triggerRefund();
        }
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getBuyerCount()     external view returns (uint256) { return _buyers.length; }
    function getBuyer(uint256 i) external view returns (address) { return _buyers[i]; }
    function remainingTickets()  external view returns (uint256) { return maxTickets - ticketsSold; }
}
