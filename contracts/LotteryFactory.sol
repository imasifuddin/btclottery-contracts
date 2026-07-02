// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {LotteryCore} from "./LotteryCore.sol";

/// @title LotteryFactory
/// @notice Deploys and tracks LotteryCore draw instances. Holds shared VRF
///         configuration and the PrizeSchemeRegistry address used by all draws.
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
    bytes32 public constant PAUSER_ROLE          = keccak256("PAUSER_ROLE");

    address[] private _lotteries;
    mapping(uint256 => address) private _lotteryById;

    address public feeRecipient;
    address public vrfCoordinator;
    uint256 public vrfSubscriptionId;
    bytes32 public vrfKeyHash;
    uint32  public vrfCallbackGasLimit;
    uint16  public vrfRequestConfirmations;

    /// @notice Registry holding reusable prize scheme configurations.
    address public prizeSchemeRegistry;

    event LotteryCreated(
        uint256 indexed lotteryId,
        address indexed lotteryAddress,
        address indexed creator,
        uint256 schemeId
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct InitParams {
        address admin;
        address feeRecipient;
        address vrfCoordinator;
        uint256 vrfSubscriptionId;
        bytes32 vrfKeyHash;
        uint32  vrfCallbackGasLimit;
        uint16  vrfRequestConfirmations;
        address prizeSchemeRegistry;
    }

    function initialize(InitParams calldata params) public initializer {
        require(params.admin != address(0),               "LotteryFactory: admin is zero address");
        require(params.feeRecipient != address(0),         "LotteryFactory: fee recipient is zero address");
        require(params.vrfCoordinator != address(0),       "LotteryFactory: VRF coordinator is zero address");
        require(params.prizeSchemeRegistry != address(0),  "LotteryFactory: registry is zero address");
        require(params.vrfCallbackGasLimit > 0,             "LotteryFactory: callbackGasLimit must be > 0");

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE,   params.admin);
        _grantRole(LOTTERY_CREATOR_ROLE, params.admin);
        _grantRole(PAUSER_ROLE,          params.admin);

        feeRecipient             = params.feeRecipient;
        vrfCoordinator           = params.vrfCoordinator;
        vrfSubscriptionId        = params.vrfSubscriptionId;
        vrfKeyHash                = params.vrfKeyHash;
        vrfCallbackGasLimit      = params.vrfCallbackGasLimit;
        vrfRequestConfirmations  = params.vrfRequestConfirmations;
        prizeSchemeRegistry      = params.prizeSchemeRegistry;
    }

    /// @notice Deploys a new LotteryCore draw referencing a prize scheme.
    function createLottery(
        uint256 ticketPrice,
        uint256 maxTickets,
        uint256 minTickets,
        uint256 drawTime,
        uint256 schemeId
    )
        external
        onlyRole(LOTTERY_CREATOR_ROLE)
        whenNotPaused
        returns (address lotteryAddress)
    {
        uint256 newId = _lotteries.length;

        LotteryCore.VRFConfig memory vrf = LotteryCore.VRFConfig({
            vrfCoordinator:        vrfCoordinator,
            subscriptionId:        vrfSubscriptionId,
            keyHash:               vrfKeyHash,
            callbackGasLimit:      vrfCallbackGasLimit,
            requestConfirmations:  vrfRequestConfirmations
        });

        LotteryCore.DrawConfig memory drawCfg = LotteryCore.DrawConfig({
            factory:              address(this),
            lotteryId:            newId,
            admin:                msg.sender,
            ticketPrice:          ticketPrice,
            maxTickets:           maxTickets,
            minTickets:           minTickets,
            drawTime:             drawTime,
            feeRecipient:         feeRecipient,
            prizeSchemeRegistry:  prizeSchemeRegistry,
            schemeId:             schemeId
        });

        LotteryCore newLottery = new LotteryCore(vrf, drawCfg);

        lotteryAddress = address(newLottery);
        _lotteries.push(lotteryAddress);
        _lotteryById[newId] = lotteryAddress;

        emit LotteryCreated(newId, lotteryAddress, msg.sender, schemeId);
    }

    function getLotteryCount() external view returns (uint256) { return _lotteries.length; }
    function getLottery(uint256 id) external view returns (address) { return _lotteryById[id]; }
    function getAllLotteries() external view returns (address[] memory) { return _lotteries; }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
