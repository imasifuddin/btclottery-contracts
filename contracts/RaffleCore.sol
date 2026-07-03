// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RaffleCore
/// @notice A single raffle instance holding a donated NFT or ERC20 prize.
///         Supports free-entry whitelisted (Merkle-proof) raffles for
///         charity, or paid open-entry raffles. Single winner selected via
///         Chainlink VRF V2.5. Automation-compatible for hands-free draws.
/// @dev NOT upgradeable — per-raffle instances are short-lived and disposable,
///      same pattern as LotteryCore. ReentrancyGuard unconditional since this
///      contract custodies prize assets and (optionally) entry fee funds.
contract RaffleCore is
    VRFConsumerBaseV2Plus,
    AutomationCompatibleInterface,
    ReentrancyGuard,
    Pausable,
    AccessControl,
    IERC721Receiver
{
    using SafeERC20 for IERC20;

    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");

    // ─── Status ──────────────────────────────────────────────────────────────

    enum RaffleStatus { Created, Open, Drawing, Completed, Cancelled }
    enum PrizeType { ERC721, ERC20 }

    // ─── VRF Config ──────────────────────────────────────────────────────────

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32  public immutable callbackGasLimit;
    uint16  public immutable requestConfirmations;
    uint256 public s_requestId;
    address public automationForwarder;

    // ─── Raffle Config ───────────────────────────────────────────────────────

    address public immutable factory;
    uint256 public immutable raffleId;

    RaffleStatus public status;
    PrizeType    public immutable prizeType;

    /// @notice Prize asset contract address (ERC721 or ERC20 depending on prizeType).
    address public immutable prizeAsset;

    /// @notice For ERC721 prizes: the token ID donated. Unused for ERC20.
    uint256 public immutable prizeTokenId;

    /// @notice For ERC20 prizes: the amount donated. Unused for ERC721.
    uint256 public immutable prizeAmount;

    /// @notice Entry fee in native token. Always 0 if isCharity is true.
    uint256 public entryFee;

    /// @notice If true, entry is always free regardless of entryFee.
    bool public immutable isCharity;

    /// @notice If true, entry is restricted to addresses in the Merkle whitelist.
    bool public immutable isWhitelisted;

    /// @notice Merkle root of the whitelist (leaf = keccak256(abi.encodePacked(address))).
    bytes32 public immutable whitelistRoot;

    uint256 public entryDeadline;
    address public winner;
    bool public prizeClaimed;

    mapping(address => bool) public hasEntered;
    address[] private _entrants;

    // ─── Events ──────────────────────────────────────────────────────────────

    event RaffleOpened(uint256 indexed raffleId, uint256 entryDeadline, bool isCharity, bool isWhitelisted);
    event EntrySubmitted(uint256 indexed raffleId, address indexed entrant, uint256 feePaid);
    event DrawRequested(uint256 indexed raffleId, uint256 requestId, uint256 entrantCount);
    event WinnerSelected(uint256 indexed raffleId, address indexed winner);
    event PrizeClaimed(uint256 indexed raffleId, address indexed winner);
    event RaffleCancelled(uint256 indexed raffleId);
    event EntryFeeRefunded(uint256 indexed raffleId, address indexed entrant, uint256 amount);
    event AutomationForwarderSet(address indexed forwarder);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotOpen();
    error NotCompleted();
    error NotCancelled();
    error DeadlineNotReached();
    error DeadlineAlreadyPassed();
    error NoEntrants();
    error AlreadyEntered();
    error NotWhitelisted();
    error IncorrectPayment();
    error AlreadyClaimed();
    error NotWinner();
    error InvalidParam(string reason);
    error TransferFailed();
    error InvalidVRFRequest();
    error NotAuthorizedForUpkeep();
    error UpkeepNotNeeded();
    error PrizeNotReceived();

    // ─── Constructor ─────────────────────────────────────────────────────────

    struct VRFConfig {
        address vrfCoordinator;
        uint256 subscriptionId;
        bytes32 keyHash;
        uint32  callbackGasLimit;
        uint16  requestConfirmations;
    }

    struct RaffleConfig {
        address factory;
        uint256 raffleId;
        address admin;
        PrizeType prizeType;
        address prizeAsset;
        uint256 prizeTokenId;   // used if prizeType == ERC721
        uint256 prizeAmount;    // used if prizeType == ERC20
        uint256 entryFee;
        bool isCharity;
        bool isWhitelisted;
        bytes32 whitelistRoot;
        uint256 entryDeadline;
    }

    constructor(VRFConfig memory vrf, RaffleConfig memory cfg)
        VRFConsumerBaseV2Plus(vrf.vrfCoordinator)
    {
        if (cfg.factory == address(0))    revert ZeroAddress();
        if (cfg.admin == address(0))      revert ZeroAddress();
        if (cfg.prizeAsset == address(0)) revert ZeroAddress();
        if (cfg.entryDeadline <= block.timestamp) revert InvalidParam("entryDeadline must be in future");
        if (vrf.callbackGasLimit == 0)    revert InvalidParam("callbackGasLimit must be > 0");
        if (cfg.prizeType == PrizeType.ERC20 && cfg.prizeAmount == 0) {
            revert InvalidParam("prizeAmount must be > 0 for ERC20");
        }
        if (cfg.isWhitelisted && cfg.whitelistRoot == bytes32(0)) {
            revert InvalidParam("whitelistRoot required when isWhitelisted");
        }

        subscriptionId        = vrf.subscriptionId;
        keyHash                = vrf.keyHash;
        callbackGasLimit       = vrf.callbackGasLimit;
        requestConfirmations   = vrf.requestConfirmations;

        factory       = cfg.factory;
        raffleId      = cfg.raffleId;
        prizeType     = cfg.prizeType;
        prizeAsset    = cfg.prizeAsset;
        prizeTokenId  = cfg.prizeTokenId;
        prizeAmount   = cfg.prizeAmount;
        entryFee      = cfg.isCharity ? 0 : cfg.entryFee;
        isCharity     = cfg.isCharity;
        isWhitelisted = cfg.isWhitelisted;
        whitelistRoot = cfg.whitelistRoot;
        entryDeadline = cfg.entryDeadline;

        _grantRole(DEFAULT_ADMIN_ROLE, cfg.admin);
        _grantRole(OPERATOR_ROLE, cfg.admin);
        _grantRole(PAUSER_ROLE, cfg.admin);

        status = RaffleStatus.Created;
        emit RaffleOpened(cfg.raffleId, cfg.entryDeadline, cfg.isCharity, cfg.isWhitelisted);
    }

    // ─── Prize Deposit ───────────────────────────────────────────────────────

    /// @notice Deposits the ERC721 prize into this contract. Must be called
    ///         (with prior NFT approval) before the raffle can open.
    function depositERC721Prize() external onlyRole(OPERATOR_ROLE) {
        if (prizeType != PrizeType.ERC721) revert InvalidParam("not an ERC721 raffle");
        if (status != RaffleStatus.Created) revert NotOpen();

        IERC721(prizeAsset).safeTransferFrom(msg.sender, address(this), prizeTokenId);
        status = RaffleStatus.Open;
    }

    /// @notice Deposits the ERC20 prize into this contract. Must be called
    ///         (with prior token approval) before the raffle can open.
    function depositERC20Prize() external onlyRole(OPERATOR_ROLE) {
        if (prizeType != PrizeType.ERC20) revert InvalidParam("not an ERC20 raffle");
        if (status != RaffleStatus.Created) revert NotOpen();

        IERC20(prizeAsset).safeTransferFrom(msg.sender, address(this), prizeAmount);
        status = RaffleStatus.Open;
    }

    /// @dev Required for this contract to receive ERC721 tokens via safeTransferFrom.
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── Entry ───────────────────────────────────────────────────────────────

    /// @notice Enter the raffle. Requires Merkle proof if isWhitelisted.
    ///         Requires exact entryFee payment unless isCharity.
    /// @param merkleProof Proof of whitelist membership (empty array if not whitelisted).
    function enter(bytes32[] calldata merkleProof)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (status != RaffleStatus.Open)     revert NotOpen();
        if (block.timestamp >= entryDeadline) revert DeadlineAlreadyPassed();
        if (hasEntered[msg.sender])           revert AlreadyEntered();
        if (msg.value != entryFee)            revert IncorrectPayment();

        if (isWhitelisted) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
            if (!MerkleProof.verify(merkleProof, whitelistRoot, leaf)) {
                revert NotWhitelisted();
            }
        }

        hasEntered[msg.sender] = true;
        _entrants.push(msg.sender);

        emit EntrySubmitted(raffleId, msg.sender, msg.value);
    }

    // ─── Draw ────────────────────────────────────────────────────────────────

    function requestDraw() external onlyRole(OPERATOR_ROLE) nonReentrant {
        _requestDraw();
    }

    function _requestDraw() internal {
        if (status != RaffleStatus.Open)      revert NotOpen();
        if (block.timestamp < entryDeadline)  revert DeadlineNotReached();
        if (_entrants.length == 0)            revert NoEntrants();

        status = RaffleStatus.Drawing;

        s_requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              keyHash,
                subId:                subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:     callbackGasLimit,
                numWords:             1,
                extraArgs:            VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                )
            })
        );

        emit DrawRequested(raffleId, s_requestId, _entrants.length);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal override
    {
        if (requestId != s_requestId)         revert InvalidVRFRequest();
        if (status != RaffleStatus.Drawing)   revert NotOpen();

        uint256 winnerIndex = randomWords[0] % _entrants.length;
        winner = _entrants[winnerIndex];
        status = RaffleStatus.Completed;

        emit WinnerSelected(raffleId, winner);
    }

    // ─── Prize Claim ─────────────────────────────────────────────────────────

    function claimPrize() external nonReentrant {
        if (status != RaffleStatus.Completed) revert NotCompleted();
        if (msg.sender != winner)             revert NotWinner();
        if (prizeClaimed)                     revert AlreadyClaimed();

        prizeClaimed = true;
        emit PrizeClaimed(raffleId, msg.sender);

        if (prizeType == PrizeType.ERC721) {
            IERC721(prizeAsset).safeTransferFrom(address(this), msg.sender, prizeTokenId);
        } else {
            IERC20(prizeAsset).safeTransfer(msg.sender, prizeAmount);
        }
    }

    // ─── Cancellation (e.g. zero entrants at deadline) ───────────────────────

    /// @notice Cancels the raffle and returns the prize to the operator.
    ///         Callable if deadline passed with zero entrants, or manually
    ///         by an operator before the deadline.
    function cancelRaffle() external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (status != RaffleStatus.Open) revert NotOpen();

        status = RaffleStatus.Cancelled;
        emit RaffleCancelled(raffleId);

        if (prizeType == PrizeType.ERC721) {
            IERC721(prizeAsset).safeTransferFrom(address(this), msg.sender, prizeTokenId);
        } else {
            IERC20(prizeAsset).safeTransfer(msg.sender, prizeAmount);
        }
    }

    /// @notice Entrants claim back their entry fee if the raffle was cancelled.
    function claimEntryRefund() external nonReentrant {
        if (status != RaffleStatus.Cancelled) revert NotCancelled();
        if (!hasEntered[msg.sender])          revert NoEntrants();
        if (entryFee == 0)                    revert InvalidParam("no fee to refund");

        hasEntered[msg.sender] = false; // prevent double refund

        emit EntryFeeRefunded(raffleId, msg.sender, entryFee);

        (bool success,) = msg.sender.call{value: entryFee}("");
        if (!success) revert TransferFailed();
    }

    // ─── Chainlink Automation ────────────────────────────────────────────────

    function setAutomationForwarder(address forwarder) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (forwarder == address(0)) revert ZeroAddress();
        automationForwarder = forwarder;
        emit AutomationForwarderSet(forwarder);
    }

    function checkUpkeep(bytes calldata)
        external view override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (status != RaffleStatus.Open) return (false, bytes(""));
        if (block.timestamp < entryDeadline) return (false, bytes(""));
        if (_entrants.length == 0) return (false, bytes(""));
        return (true, bytes(""));
    }

    function performUpkeep(bytes calldata) external override nonReentrant {
        if (automationForwarder != address(0)) {
            if (msg.sender != automationForwarder && !hasRole(OPERATOR_ROLE, msg.sender)) {
                revert NotAuthorizedForUpkeep();
            }
        } else {
            if (!hasRole(OPERATOR_ROLE, msg.sender)) revert NotAuthorizedForUpkeep();
        }

        if (status != RaffleStatus.Open)     revert UpkeepNotNeeded();
        if (block.timestamp < entryDeadline) revert UpkeepNotNeeded();
        if (_entrants.length == 0)           revert UpkeepNotNeeded();

        _requestDraw();
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getEntrantCount() external view returns (uint256) { return _entrants.length; }
    function getEntrant(uint256 i) external view returns (address) { return _entrants[i]; }
}
