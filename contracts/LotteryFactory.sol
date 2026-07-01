// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {Lottery} from "./Lottery.sol";

/// @title LotteryFactory
/// @notice Deploys and tracks individual Lottery draw contracts for the
///         btclottery.io platform. This contract is upgradeable (UUPS);
///         individual Lottery instances it deploys are not.
/// @dev Storage layout: only ever APPEND new state variables below the
///      existing ones in future upgrades. Never reorder or remove.
///      Note: ReentrancyGuard is intentionally omitted from this contract.
///      The factory holds no funds and emits no external calls that could
///      re-enter meaningfully. ReentrancyGuard is reserved for LotteryCore,
///      which holds user funds and requires it unconditionally.
contract LotteryFactory is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    /// @notice Role permitted to create new lottery draws.
    bytes32 public constant LOTTERY_CREATOR_ROLE = keccak256("LOTTERY_CREATOR_ROLE");

    /// @notice Role permitted to pause/unpause lottery creation.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice All deployed lottery addresses, in creation order.
    address[] private _lotteries;

    /// @notice lotteryId => deployed Lottery contract address.
    mapping(uint256 => address) private _lotteryById;

    /// @notice Emitted whenever a new Lottery draw contract is deployed.
    /// @param lotteryId Sequential ID assigned to this lottery.
    /// @param lotteryAddress Address of the newly deployed Lottery contract.
    /// @param creator Address that triggered the creation.
    event LotteryCreated(
        uint256 indexed lotteryId,
        address indexed lotteryAddress,
        address indexed creator
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the factory. Replaces a constructor for upgradeable contracts.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE, LOTTERY_CREATOR_ROLE, and PAUSER_ROLE.
    function initialize(address admin) public initializer {
        require(admin != address(0), "LotteryFactory: admin is zero address");

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(LOTTERY_CREATOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /// @notice Deploys a new Lottery draw contract and registers it.
    /// @return lotteryAddress The address of the newly deployed Lottery contract.
    function createLottery()
        external
        onlyRole(LOTTERY_CREATOR_ROLE)
        whenNotPaused
        returns (address lotteryAddress)
    {
        uint256 newId = _lotteries.length;

        Lottery newLottery = new Lottery(address(this), newId);
        lotteryAddress = address(newLottery);

        _lotteries.push(lotteryAddress);
        _lotteryById[newId] = lotteryAddress;

        emit LotteryCreated(newId, lotteryAddress, msg.sender);
    }

    /// @notice Returns the total number of lotteries created.
    function getLotteryCount() external view returns (uint256) {
        return _lotteries.length;
    }

    /// @notice Returns the address of a lottery by its sequential ID.
    function getLottery(uint256 lotteryId) external view returns (address) {
        return _lotteryById[lotteryId];
    }

    /// @notice Returns all deployed lottery addresses.
    /// @dev For large registries, prefer getLotteryCount + getLottery for pagination.
    function getAllLotteries() external view returns (address[] memory) {
        return _lotteries;
    }

    /// @notice Pauses lottery creation. Does not affect existing Lottery contracts.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses lottery creation.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Restricts upgrade authorization to DEFAULT_ADMIN_ROLE.
    ///      This is the single most security-critical function in this contract:
    ///      anyone able to call this can replace the entire contract's logic.
    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
