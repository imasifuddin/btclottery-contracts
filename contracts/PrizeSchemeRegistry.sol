// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PrizeSchemeRegistry
/// @notice Stores reusable prize tier configurations that LotteryCore
///         instances reference at creation time. Admins define schemes
///         once (e.g. "Standard 3-tier", "Winner-takes-all") and reuse
///         them across many draws.
/// @dev NOT upgradeable. A registry is simple, low-risk infrastructure;
///      if tier logic needs to change, deploy a new registry and point
///      new draws at it — existing draws keep referencing their original
///      scheme snapshot regardless.
contract PrizeSchemeRegistry is AccessControl {

    /// @notice Role permitted to create and deactivate prize schemes.
    bytes32 public constant SCHEME_MANAGER_ROLE = keccak256("SCHEME_MANAGER_ROLE");

    /// @notice Hard cap on tiers per scheme — bounds VRF callback gas cost.
    uint256 public constant MAX_TIERS = 10;

    /// @notice Maximum total bps across fee + all tiers (10000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10000;

    struct PrizeScheme {
        string name;
        uint256[] tierBps;      // e.g. [5000, 3000, 1000] = 50%, 30%, 10%
        uint256 feeBps;         // platform fee, taken before tier split
        bool isJackpot;         // if true, unmet minTickets rolls pool forward instead of refunding
        bool active;
    }

    /// @notice schemeId => PrizeScheme
    mapping(uint256 => PrizeScheme) private _schemes;

    /// @notice Total number of schemes ever created.
    uint256 public schemeCount;

    event SchemeCreated(uint256 indexed schemeId, string name, uint256 tierCount, bool isJackpot);
    event SchemeDeactivated(uint256 indexed schemeId);

    error InvalidParam(string reason);
    error SchemeNotFound();
    error SchemeInactive();

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and SCHEME_MANAGER_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert InvalidParam("admin is zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCHEME_MANAGER_ROLE, admin);
    }

    /// @notice Creates a new reusable prize scheme.
    /// @param name       Human-readable scheme name (e.g. "Standard 3-tier").
    /// @param tierBps    Array of basis-point splits per rank, e.g. [5000, 3000, 1000].
    ///                   tierBps[0] = Rank 1 (jackpot winner), tierBps[1] = Rank 2, etc.
    /// @param feeBps     Platform fee in basis points, taken before tier split.
    /// @param isJackpot  If true, unmet minTickets rolls the pool to the next draw
    ///                   instead of triggering refunds (rollover logic added separately).
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

    /// @notice Deactivates a scheme so it can no longer be used for new draws.
    ///         Existing draws already referencing it are unaffected.
    function deactivateScheme(uint256 schemeId) external onlyRole(SCHEME_MANAGER_ROLE) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        _schemes[schemeId].active = false;
        emit SchemeDeactivated(schemeId);
    }

    /// @notice Returns full scheme details. Reverts if scheme doesn't exist.
    function getScheme(uint256 schemeId) external view returns (PrizeScheme memory) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId];
    }

    /// @notice Returns the number of prize tiers in a scheme.
    function getTierCount(uint256 schemeId) external view returns (uint256) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId].tierBps.length;
    }

    /// @notice Returns whether a scheme is currently active and usable.
    function isSchemeActive(uint256 schemeId) external view returns (bool) {
        if (schemeId >= schemeCount) revert SchemeNotFound();
        return _schemes[schemeId].active;
    }
}
