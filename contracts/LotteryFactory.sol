// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {LotteryCore} from "./LotteryCore.sol";

/// @title LotteryFactory
/// @notice Deploys and tracks LotteryCore draw instances.
///         Holds shared VRF and fee configuration used by all draws.
///         This contract is upgradeable (UUPS); individual draws are not.
/// @dev Storage layout: only ever APPEND new state variables below existing
///      ones in future upgrades. Never reorder or remove.
contract LotteryFactory is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant LOTTERY_CREATOR_ROLE = keccak256("LOTTERY_CREATOR_ROLE");
    bytes32 public constant PAUSER_ROLE          = keccak256("PAUSER_ROLE");

    // ─── Registry ────────────────────────────────────────────────────────────

    address[] private _lotteries;
    mapping(uint256 => address) private _lotteryById;

    // ─── Shared Config ───────────────────────────────────────────────────────

    /// @notice Default platform fee in basis points (e.g. 500 = 5%).
    uint256 public defaultFeeBps;

    /// @notice Default address receiving platform fees.
    address public defaultFeeRecipient;

    /// @notice Chainlink VRF Coordinator address for the current network.
    address public vrfCoordinator;

    /// @notice Chainlink VRF subscription ID (funded with LINK).
    uint256 public vrfSubscriptionId;

    /// @notice VRF key hash / gas lane for the target network.
    bytes32 public vrfKeyHash;

    /// @notice Gas limit for the VRF fulfillRandomWords callback.
    uint32 public vrfCallbackGasLimit;

    /// @notice Block confirmations before VRF response is accepted.
    uint16 public vrfRequestConfirmations;

    // ─── Events ──────────────────────────────────────────────────────────────

    event LotteryCreated(
        uint256 indexed lotteryId,
        address indexed lotteryAddress,
        address indexed creator
    );

    // ─── Constructor / Initializer ───────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin                  Address granted all roles.
    /// @param _defaultFeeBps         Default platform fee in bps.
    /// @param _feeRecipient          Default fee recipient address.
    /// @param _vrfCoordinator        Chainlink VRF Coordinator address.
    /// @param _vrfSubscriptionId     Chainlink VRF subscription ID.
    /// @param _vrfKeyHash            VRF key hash for the target network.
    /// @param _vrfCallbackGasLimit   Gas limit for VRF callback.
    /// @param _vrfRequestConfirmations Block confirmations for VRF.
    function initialize(
        address admin,
        uint256 _defaultFeeBps,
        address _feeRecipient,
        address _vrfCoordinator,
        uint256 _vrfSubscriptionId,
        bytes32 _vrfKeyHash,
        uint32  _vrfCallbackGasLimit,
        uint16  _vrfRequestConfirmations
    ) public initializer {
        require(admin != address(0),         "LotteryFactory: admin is zero address");
        require(_feeRecipient != address(0), "LotteryFactory: fee recipient is zero address");
        require(_vrfCoordinator != address(0), "LotteryFactory: VRF coordinator is zero address");
        require(_defaultFeeBps <= 1000,      "LotteryFactory: fee max 10%");
        require(_vrfCallbackGasLimit > 0,    "LotteryFactory: callbackGasLimit must be > 0");

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE,    admin);
        _grantRole(LOTTERY_CREATOR_ROLE,  admin);
        _grantRole(PAUSER_ROLE,           admin);

        defaultFeeBps            = _defaultFeeBps;
        defaultFeeRecipient      = _feeRecipient;
        vrfCoordinator           = _vrfCoordinator;
        vrfSubscriptionId        = _vrfSubscriptionId;
        vrfKeyHash               = _vrfKeyHash;
        vrfCallbackGasLimit      = _vrfCallbackGasLimit;
        vrfRequestConfirmations  = _vrfRequestConfirmations;
    }

    // ─── Factory ─────────────────────────────────────────────────────────────

    /// @notice Deploys a new LotteryCore draw and registers it in the registry.
    /// @param ticketPrice  Price per ticket in wei.
    /// @param maxTickets   Hard cap on tickets.
    /// @param minTickets   Minimum tickets required for draw to proceed.
    /// @param drawTime     Unix timestamp when sales close.
    function createLottery(
        uint256 ticketPrice,
        uint256 maxTickets,
        uint256 minTickets,
        uint256 drawTime
    )
        external
        onlyRole(LOTTERY_CREATOR_ROLE)
        whenNotPaused
        returns (address lotteryAddress)
    {
        uint256 newId = _lotteries.length;

        LotteryCore newLottery = new LotteryCore(
            vrfCoordinator,
            vrfSubscriptionId,
            vrfKeyHash,
            vrfCallbackGasLimit,
            vrfRequestConfirmations,
            address(this),
            newId,
            msg.sender,
            ticketPrice,
            maxTickets,
            minTickets,
            drawTime,
            defaultFeeBps,
            defaultFeeRecipient
        );

        lotteryAddress = address(newLottery);
        _lotteries.push(lotteryAddress);
        _lotteryById[newId] = lotteryAddress;

        emit LotteryCreated(newId, lotteryAddress, msg.sender);
    }

    // ─── Registry Views ──────────────────────────────────────────────────────

    function getLotteryCount() external view returns (uint256) { return _lotteries.length; }
    function getLottery(uint256 id) external view returns (address) { return _lotteryById[id]; }
    function getAllLotteries() external view returns (address[] memory) { return _lotteries; }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
