// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LotteryCore
/// @notice A single lottery draw instance deployed by LotteryFactory.
///         Handles ticket sales (native token), prize pool accumulation,
///         Chainlink VRF V2.5 provably-fair winner selection, prize payout,
///         and refunds if minimum tickets are not met.
/// @dev NOT upgradeable — individual draws are short-lived.
///      Uses CEI (Checks-Effects-Interactions) pattern on all fund movements.
///      ReentrancyGuard is unconditional since this contract holds user funds.
contract LotteryCore is
    VRFConsumerBaseV2Plus,
    ReentrancyGuard,
    Pausable,
    AccessControl
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");

    // ─── Lottery Status ──────────────────────────────────────────────────────

    enum LotteryStatus {
        Created,    // Not used — deploy goes straight to Open
        Open,       // Ticket sales active
        Drawing,    // VRF request sent, awaiting callback
        Completed,  // Winner selected, prize claimable
        Refunding   // Min tickets not met, refunds active
    }

    // ─── VRF Config ──────────────────────────────────────────────────────────

    /// @notice Chainlink VRF subscription ID.
    uint256 public immutable subscriptionId;

    /// @notice VRF key hash (gas lane) for the target network.
    bytes32 public immutable keyHash;

    /// @notice Gas limit for the VRF fulfillment callback.
    uint32 public immutable callbackGasLimit;

    /// @notice Number of block confirmations before VRF response is accepted.
    uint16 public immutable requestConfirmations;

    /// @notice VRF request ID, set when requestDraw() is called.
    uint256 public s_requestId;

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
    uint256 public feeBps;
    address public feeRecipient;
    address public winner;

    mapping(address => uint256) public ticketsBought;
    address[] private _buyers;
    mapping(address => bool) public refundClaimed;
    bool public prizeClaimed;

    // ─── Events ──────────────────────────────────────────────────────────────

    event LotteryOpened(uint256 indexed lotteryId, uint256 drawTime, uint256 ticketPrice);
    event TicketsPurchased(uint256 indexed lotteryId, address indexed buyer, uint256 count, uint256 totalPaid);
    event DrawRequested(uint256 indexed lotteryId, uint256 requestId, uint256 ticketsSold);
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
    error InvalidParam(string reason);
    error TransferFailed();
    error InvalidVRFRequest();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _vrfCoordinator   Chainlink VRF Coordinator address for this network.
    /// @param _subscriptionId   Chainlink VRF subscription ID (must be funded with LINK).
    /// @param _keyHash          VRF key hash / gas lane for the target network.
    /// @param _callbackGasLimit Gas limit for the VRF fulfillRandomWords callback.
    /// @param _requestConfirmations Block confirmations before VRF response is valid.
    /// @param _factory          LotteryFactory address that deployed this instance.
    /// @param _lotteryId        Sequential ID assigned by the factory.
    /// @param _admin            Address granted admin + operator + pauser roles.
    /// @param _ticketPrice      Price per ticket in wei (native token).
    /// @param _maxTickets       Hard cap on tickets sold.
    /// @param _minTickets       Minimum tickets required for draw to proceed.
    /// @param _drawTime         Unix timestamp when ticket sales close.
    /// @param _feeBps           Platform fee in basis points (max 1000 = 10%).
    /// @param _feeRecipient     Address receiving the platform fee.
    constructor(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32  _callbackGasLimit,
        uint16  _requestConfirmations,
        address _factory,
        uint256 _lotteryId,
        address _admin,
        uint256 _ticketPrice,
        uint256 _maxTickets,
        uint256 _minTickets,
        uint256 _drawTime,
        uint256 _feeBps,
        address _feeRecipient
    )
        VRFConsumerBaseV2Plus(_vrfCoordinator)
    {
        if (_factory == address(0))      revert ZeroAddress();
        if (_admin == address(0))        revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_ticketPrice == 0)           revert InvalidParam("ticketPrice must be > 0");
        if (_maxTickets == 0)            revert InvalidParam("maxTickets must be > 0");
        if (_minTickets == 0)            revert InvalidParam("minTickets must be > 0");
        if (_minTickets > _maxTickets)   revert InvalidParam("minTickets > maxTickets");
        if (_drawTime <= block.timestamp) revert InvalidParam("drawTime must be in future");
        if (_feeBps > 1000)              revert InvalidParam("feeBps max 10%");
        if (_callbackGasLimit == 0)      revert InvalidParam("callbackGasLimit must be > 0");

        subscriptionId      = _subscriptionId;
        keyHash             = _keyHash;
        callbackGasLimit    = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;

        factory      = _factory;
        lotteryId    = _lotteryId;
        ticketPrice  = _ticketPrice;
        maxTickets   = _maxTickets;
        minTickets   = _minTickets;
        drawTime     = _drawTime;
        feeBps       = _feeBps;
        feeRecipient = _feeRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);

        status = LotteryStatus.Open;
        emit LotteryOpened(_lotteryId, _drawTime, _ticketPrice);
    }

    // ─── Ticket Purchase ─────────────────────────────────────────────────────

    /// @notice Purchase one or more tickets with native token.
    function buyTickets(uint256 count)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (status != LotteryStatus.Open)          revert NotOpen();
        if (block.timestamp >= drawTime)           revert DrawTimeAlreadyPassed();
        if (count == 0)                            revert InvalidParam("count must be > 0");
        if (ticketsSold + count > maxTickets)      revert SoldOut();
        if (msg.value != ticketPrice * count)      revert IncorrectPayment();

        if (ticketsBought[msg.sender] == 0) {
            _buyers.push(msg.sender);
        }
        ticketsBought[msg.sender] += count;
        ticketsSold               += count;
        prizePool                 += msg.value;

        emit TicketsPurchased(lotteryId, msg.sender, count, msg.value);
    }

    // ─── Draw ────────────────────────────────────────────────────────────────

    /// @notice Request a provably-fair winner draw via Chainlink VRF V2.5.
    ///         Callable only after drawTime if minTickets have been sold.
    function requestDraw()
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (status != LotteryStatus.Open)      revert NotOpen();
        if (block.timestamp < drawTime)        revert DrawTimeNotReached();
        if (ticketsSold < minTickets)          revert MinTicketsNotMet();

        status = LotteryStatus.Drawing;

        s_requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:             keyHash,
                subId:               subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:    callbackGasLimit,
                numWords:            1,
                extraArgs:           VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                )
            })
        );

        emit DrawRequested(lotteryId, s_requestId, ticketsSold);
    }

    /// @notice Chainlink VRF V2.5 callback — called by the VRF Coordinator only.
    /// @dev    SECURITY: VRFConsumerBaseV2Plus enforces that only the coordinator
    ///         can call this via rawFulfillRandomWords(). Do not add access modifiers.
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        if (requestId != s_requestId)          revert InvalidVRFRequest();
        if (status != LotteryStatus.Drawing)   revert NotOpen();

        // Select winner weighted by ticket count
        uint256 winningTicket = randomWords[0] % ticketsSold;
        uint256 cumulative    = 0;
        address selectedWinner;

        for (uint256 i = 0; i < _buyers.length; i++) {
            cumulative += ticketsBought[_buyers[i]];
            if (winningTicket < cumulative) {
                selectedWinner = _buyers[i];
                break;
            }
        }

        winner = selectedWinner;
        status = LotteryStatus.Completed;

        uint256 fee   = (prizePool * feeBps) / 10000;
        uint256 prize = prizePool - fee;

        emit WinnerSelected(lotteryId, selectedWinner, prize);

        // Pay platform fee immediately (state already updated — CEI satisfied)
        if (fee > 0) {
            (bool feeSuccess,) = feeRecipient.call{value: fee}("");
            if (!feeSuccess) revert TransferFailed();
        }
    }

    // ─── Prize Claim ─────────────────────────────────────────────────────────

    /// @notice Winner claims their prize after draw completes.
    function claimPrize() external nonReentrant {
        if (status != LotteryStatus.Completed) revert NotCompleted();
        if (msg.sender != winner)              revert NotWinner();
        if (prizeClaimed)                      revert AlreadyClaimed();

        prizeClaimed = true;

        uint256 fee   = (prizePool * feeBps) / 10000;
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
        if (status != LotteryStatus.Open)  revert NotOpen();
        if (block.timestamp < drawTime)    revert DrawTimeNotReached();
        if (ticketsSold >= minTickets)     revert MinTicketsMet();

        status = LotteryStatus.Refunding;
        emit RefundTriggered(lotteryId, ticketsSold);
    }

    /// @notice Buyers claim their individual refunds when in Refunding status.
    function claimRefund() external nonReentrant {
        if (status != LotteryStatus.Refunding)     revert NotRefunding();
        if (ticketsBought[msg.sender] == 0)        revert NoTicketsPurchased();
        if (refundClaimed[msg.sender])             revert AlreadyClaimed();

        uint256 refundAmount = ticketsBought[msg.sender] * ticketPrice;
        refundClaimed[msg.sender] = true;

        emit RefundClaimed(lotteryId, msg.sender, refundAmount);

        (bool success,) = msg.sender.call{value: refundAmount}("");
        if (!success) revert TransferFailed();
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getBuyerCount()      external view returns (uint256) { return _buyers.length; }
    function getBuyer(uint256 i)  external view returns (address) { return _buyers[i]; }
    function remainingTickets()   external view returns (uint256) { return maxTickets - ticketsSold; }
}
