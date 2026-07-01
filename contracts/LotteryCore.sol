// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title LotteryCore
/// @notice A single lottery draw instance deployed by LotteryFactory.
///         Handles ticket sales (native token), prize pool accumulation,
///         refunds if minimum tickets not met, and prize payout to winner.
/// @dev Intentionally NOT upgradeable — individual draws are short-lived.
///      Winner selection via Chainlink VRF is stubbed and wired in Day 5.
///      Uses CEI (Checks-Effects-Interactions) pattern on all fund movements.
///      ReentrancyGuard is unconditional here since this contract holds funds.
contract LotteryCore is ReentrancyGuard, Pausable, AccessControl {

    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Can trigger the draw and manage lottery state.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Can pause/unpause ticket sales.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ─── Status ──────────────────────────────────────────────────────────────

    enum LotteryStatus {
        Created,    // Initialized, not yet open
        Open,       // Ticket sales active
        Drawing,    // Draw requested, awaiting VRF (stub for now)
        Completed,  // Winner selected, prize claimable
        Refunding   // Min tickets not met, refunds active
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice Address of the LotteryFactory that deployed this instance.
    address public immutable factory;

    /// @notice Sequential ID assigned by the factory.
    uint256 public immutable lotteryId;

    /// @notice Current lifecycle status of this lottery.
    LotteryStatus public status;

    /// @notice Price per ticket in native token (wei).
    uint256 public ticketPrice;

    /// @notice Maximum number of tickets that can be sold.
    uint256 public maxTickets;

    /// @notice Minimum tickets required for draw to proceed (else refund).
    uint256 public minTickets;

    /// @notice Running count of tickets sold.
    uint256 public ticketsSold;

    /// @notice Accumulated prize pool in native token (wei).
    uint256 public prizePool;

    /// @notice Unix timestamp after which ticket sales close.
    uint256 public drawTime;

    /// @notice Platform fee in basis points (e.g. 500 = 5%).
    uint256 public feeBps;

    /// @notice Address that receives the platform fee.
    address public feeRecipient;

    /// @notice Address of the draw winner. Zero until Completed.
    address public winner;

    /// @notice Tickets purchased per buyer address.
    mapping(address => uint256) public ticketsBought;

    /// @notice Ordered list of unique buyers (for refund iteration).
    address[] private _buyers;

    /// @notice Tracks whether an address has already claimed their refund.
    mapping(address => bool) public refundClaimed;

    /// @notice Tracks whether the winner has claimed their prize.
    bool public prizeClaimed;

    // ─── Events ──────────────────────────────────────────────────────────────

    event LotteryOpened(uint256 indexed lotteryId, uint256 drawTime, uint256 ticketPrice);
    event TicketsPurchased(uint256 indexed lotteryId, address indexed buyer, uint256 count, uint256 totalPaid);
    event DrawRequested(uint256 indexed lotteryId, uint256 ticketsSold);
    event WinnerSelected(uint256 indexed lotteryId, address indexed winner, uint256 prize);
    event PrizeClaimed(uint256 indexed lotteryId, address indexed winner, uint256 amount);
    event RefundTriggered(uint256 indexed lotteryId, uint256 ticketsSold);
    event RefundClaimed(uint256 indexed lotteryId, address indexed buyer, uint256 amount);

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
    error ZeroAddress();
    error InvalidParam(string reason);
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _factory      Address of the deploying LotteryFactory.
    /// @param _lotteryId    Sequential ID assigned by the factory.
    /// @param _admin        Address granted DEFAULT_ADMIN_ROLE + OPERATOR_ROLE + PAUSER_ROLE.
    /// @param _ticketPrice  Price per ticket in wei.
    /// @param _maxTickets   Hard cap on tickets sold.
    /// @param _minTickets   Minimum tickets required for draw to proceed.
    /// @param _drawTime     Unix timestamp when ticket sales close.
    /// @param _feeBps       Platform fee in basis points (max 1000 = 10%).
    /// @param _feeRecipient Address receiving the platform fee.
    constructor(
        address _factory,
        uint256 _lotteryId,
        address _admin,
        uint256 _ticketPrice,
        uint256 _maxTickets,
        uint256 _minTickets,
        uint256 _drawTime,
        uint256 _feeBps,
        address _feeRecipient
    ) {
        if (_factory == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_ticketPrice == 0) revert InvalidParam("ticketPrice must be > 0");
        if (_maxTickets == 0) revert InvalidParam("maxTickets must be > 0");
        if (_minTickets == 0) revert InvalidParam("minTickets must be > 0");
        if (_minTickets > _maxTickets) revert InvalidParam("minTickets > maxTickets");
        if (_drawTime <= block.timestamp) revert InvalidParam("drawTime must be in future");
        if (_feeBps > 1000) revert InvalidParam("feeBps max 10%");

        factory = _factory;
        lotteryId = _lotteryId;
        ticketPrice = _ticketPrice;
        maxTickets = _maxTickets;
        minTickets = _minTickets;
        drawTime = _drawTime;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);

        status = LotteryStatus.Open;

        emit LotteryOpened(_lotteryId, _drawTime, _ticketPrice);
    }

    // ─── Ticket Purchase ─────────────────────────────────────────────────────

    /// @notice Purchase one or more tickets.
    /// @param count Number of tickets to purchase (must be >= 1).
    function buyTickets(uint256 count)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        // Checks
        if (status != LotteryStatus.Open) revert NotOpen();
        if (block.timestamp >= drawTime) revert DrawTimeAlreadyPassed();
        if (count == 0) revert InvalidParam("count must be > 0");
        if (ticketsSold + count > maxTickets) revert SoldOut();
        if (msg.value != ticketPrice * count) revert IncorrectPayment();

        // Effects
        if (ticketsBought[msg.sender] == 0) {
            _buyers.push(msg.sender);
        }
        ticketsBought[msg.sender] += count;
        ticketsSold += count;
        prizePool += msg.value;

        emit TicketsPurchased(lotteryId, msg.sender, count, msg.value);
    }

    // ─── Draw ────────────────────────────────────────────────────────────────

    /// @notice Request a winner draw. Callable after drawTime if minTickets met.
    /// @dev VRF call is stubbed here — Day 5 wires in real Chainlink VRF.
    ///      For now, sets status to Drawing immediately.
    function requestDraw()
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (status != LotteryStatus.Open) revert NotOpen();
        if (block.timestamp < drawTime) revert DrawTimeNotReached();
        if (ticketsSold < minTickets) revert MinTicketsNotMet();

        status = LotteryStatus.Drawing;
        emit DrawRequested(lotteryId, ticketsSold);

        // TODO Day 5: call Chainlink VRF requestRandomWords() here
        // For now, stub resolves immediately in fulfillRandomWords()
    }

    /// @notice Stub winner selection — replaced by real VRF callback on Day 5.
    /// @dev TEMPORARY: called manually by OPERATOR in tests only.
    ///      In production, Chainlink VRF calls fulfillRandomWords() directly.
    function fulfillRandomWords(uint256 randomWord)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (status != LotteryStatus.Drawing) revert NotOpen();

        // Select winner from buyers array using random word modulo
        uint256 winnerIndex = randomWord % _buyers.length;
        // Weight by tickets: iterate through buyers until we find
        // which buyer owns the winning ticket number
        uint256 winningTicket = randomWord % ticketsSold;
        uint256 cumulative = 0;
        address selectedWinner;
        for (uint256 i = 0; i < _buyers.length; i++) {
            cumulative += ticketsBought[_buyers[i]];
            if (winningTicket < cumulative) {
                selectedWinner = _buyers[i];
                break;
            }
        }
        // Fallback safety (should never hit due to above logic)
        if (selectedWinner == address(0)) {
            selectedWinner = _buyers[winnerIndex % _buyers.length];
        }

        winner = selectedWinner;
        status = LotteryStatus.Completed;

        // Calculate prize after platform fee
        uint256 fee = (prizePool * feeBps) / 10000;
        uint256 prize = prizePool - fee;

        emit WinnerSelected(lotteryId, selectedWinner, prize);

        // Pay platform fee immediately (CEI: status already updated above)
        if (fee > 0) {
            (bool feeSuccess,) = feeRecipient.call{value: fee}("");
            if (!feeSuccess) revert TransferFailed();
        }
    }

    // ─── Prize Claim ─────────────────────────────────────────────────────────

    /// @notice Winner claims their prize.
    function claimPrize()
        external
        nonReentrant
    {
        if (status != LotteryStatus.Completed) revert NotCompleted();
        if (msg.sender != winner) revert NotWinner();
        if (prizeClaimed) revert AlreadyClaimed();

        // Effects before interaction (CEI)
        prizeClaimed = true;

        uint256 fee = (prizePool * feeBps) / 10000;
        uint256 prize = prizePool - fee;

        emit PrizeClaimed(lotteryId, msg.sender, prize);

        (bool success,) = msg.sender.call{value: prize}("");
        if (!success) revert TransferFailed();
    }

    // ─── Refunds ─────────────────────────────────────────────────────────────

    /// @notice Trigger refund mode if drawTime passed and minTickets not met.
    function triggerRefund()
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (status != LotteryStatus.Open) revert NotOpen();
        if (block.timestamp < drawTime) revert DrawTimeNotReached();
        if (ticketsSold >= minTickets) revert MinTicketsMet();

        status = LotteryStatus.Refunding;
        emit RefundTriggered(lotteryId, ticketsSold);
    }

    /// @notice Buyers claim their refund when in Refunding status.
    function claimRefund()
        external
        nonReentrant
    {
        if (status != LotteryStatus.Refunding) revert NotRefunding();
        if (ticketsBought[msg.sender] == 0) revert NoTicketsPurchased();
        if (refundClaimed[msg.sender]) revert AlreadyClaimed();

        // Effects before interaction (CEI)
        uint256 refundAmount = ticketsBought[msg.sender] * ticketPrice;
        refundClaimed[msg.sender] = true;

        emit RefundClaimed(lotteryId, msg.sender, refundAmount);

        (bool success,) = msg.sender.call{value: refundAmount}("");
        if (!success) revert TransferFailed();
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    /// @notice Pause ticket sales (does not affect refunds or prize claims).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause ticket sales.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice Returns the number of unique buyers.
    function getBuyerCount() external view returns (uint256) {
        return _buyers.length;
    }

    /// @notice Returns buyer address at index (for off-chain enumeration).
    function getBuyer(uint256 index) external view returns (address) {
        return _buyers[index];
    }

    /// @notice Returns remaining tickets available for purchase.
    function remainingTickets() external view returns (uint256) {
        return maxTickets - ticketsSold;
    }
}
