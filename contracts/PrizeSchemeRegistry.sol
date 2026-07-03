// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @title PrizeSchemeRegistry
/// @notice Stores reusable prize tier configurations that LotteryCore
///         instances reference at creation time. Upgradeable (UUPS) since
///         this is long-lived platform infrastructure holding no user
///         funds or assets — safe to evolve without changing its address.
/// @dev Storage layout: only ever APPEND new state variables below existing
///      ones in future upgrades. Never reorder or remove.
contract PrizeSchemeRegistry is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable
{
    bytes32 public constant SCHEME_MANAGER_ROLE = keccak256("SCHEME_MANAGER_ROLE");

    uint256 public constant MAX_TIERS = 10;
    uint256 public constant BPS_DENOMINATOR = 10000;

    struct PrizeScheme {
        string name;
        uint256[] tierBps;
        uint256 feeBps;
        bool isJackpot;
        bool active;
    }

    mapping(uint256 => PrizeScheme) private _schemes;
    uint256 public schemeCount;

    event SchemeCreated(uint256 indexed schemeId, string name, uint256 tierCount, bool isJackpot);
    event SchemeDeactivated(uint256 indexed schemeId);

    error InvalidParam(string reason);
    error SchemeNotFound();
    error SchemeInactive();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and SCHEME_MANAGER_ROLE.
    function initialize(address admin) public initializer {
        if (admin == address(0)) revert InvalidParam("admin is zero address");

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCHEME_MANAGER_ROLE, admin);
    }

    function createScheme(
        string calldata name,
        uint256[] calldata tierBps,
        uint256 feeBps,
        bool isJackpot
    ) external onlyRole(SCHEME_MANAGER_ROLE) returns (uint256 schemeId) {
        if (bytes(name).length == 0) revert InvalidParam("name is empty");
        if (tierBps.length == 0) revert InvalidParam("must have at least 1 tier");
        if (tierBps.length > MAX_TIERS) revert InvalidParam("exceeds MAX_TIERS");
        if (feeBps > 1000) revert InvalidParam("feeBps max 10%");

        uint256 total = feeBps;
        for (uint256 i = 0; i < tierBps.length; i++) {
            if (tierBps[i] == 0) revert InvalidParam("tier bps must be > 0");
            total += tierBps[i];
        }
        if (total > BPS_DENOMINATOR) revert InvalidParam("total bps exceeds 100%");

        schemeId = schemeCount++;

        _schemes[schemeId] = PrizeScheme({
            name: name,
            tierBps: tierBps,
            feeBps: feeBps,
            isJackpot: isJackpot,
            active: true
        });

        emit SchemeCreated(schemeId, name, tierBps.length, isJackpot);
    }

    function deactivateScheme(uint256 schemeId) external onlyRole(SCHEME_MANAGER_ROLE) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        _schemes[schemeId].active = false;
        emit SchemeDeactivated(schemeId);
    }

    function getScheme(uint256 schemeId) external view returns (PrizeScheme memory) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId];
    }

    function getTierCount(uint256 schemeId) external view returns (uint256) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId].tierBps.length;
    }

    function isSchemeActive(uint256 schemeId) external view returns (bool) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId].active;
    }

    /// @dev Only DEFAULT_ADMIN_ROLE can authorize upgrades — this should
    ///      eventually be transferred to the Gnosis Safe multisig.
    function _authorizeUpgrade(address)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
