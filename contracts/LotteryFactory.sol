// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {LotteryCore} from "./LotteryCore.sol";

/// @title LotteryFactory
/// @notice Deploys and tracks individual LotteryCore draw contracts.
///         This contract is upgradeable (UUPS); individual draws are not.
/// @dev Storage layout: only ever APPEND new state variables below existing
///      ones in future upgrades. Never reorder or remove.
contract LotteryFactory is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    bytes32 public constant LOTTERY_CREATOR_ROLE = keccak256("LOTTERY_CREATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address[] private _lotteries;
    mapping(uint256 => address) private _lotteryById;

    /// @notice Default platform fee recipient — set at initialization.
    address public defaultFeeRecipient;

    /// @notice Default platform fee in basis points.
    uint256 public defaultFeeBps;

    event LotteryCreated(
        uint256 indexed lotteryId,
        address indexed lotteryAddress,
        address indexed creator
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin            Address granted all roles.
    /// @param _defaultFeeBps   Default platform fee in bps (e.g. 500 = 5%).
    /// @param _feeRecipient    Default address receiving platform fees.
    function initialize(
        address admin,
        uint256 _defaultFeeBps,
        address _feeRecipient
    ) public initializer {
        require(admin != address(0), "LotteryFactory: admin is zero address");
        require(_feeRecipient != address(0), "LotteryFactory: fee recipient is zero address");
        require(_defaultFeeBps <= 1000, "LotteryFactory: fee max 10%");

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOTTERY_CREATOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        defaultFeeBps = _defaultFeeBps;
        defaultFeeRecipient = _feeRecipient;
    }

    /// @notice Deploys a new LotteryCore draw contract.
    /// @param ticketPrice  Price per ticket in wei.
    /// @param maxTickets   Hard cap on tickets.
    /// @param minTickets   Minimum tickets for draw to proceed.
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

    function getLotteryCount() external view returns (uint256) {
        return _lotteries.length;
    }

    function getLottery(uint256 id) external view returns (address) {
        return _lotteryById[id];
    }

    function getAllLotteries() external view returns (address[] memory) {
        return _lotteries;
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
