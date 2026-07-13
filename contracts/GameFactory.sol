// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {GameCore} from "./GameCore.sol";

/// @title GameFactory
/// @notice Deploys GameCore instances from whatever game+scheme payload the
///         admin configured — fully dynamic. Called by our API service when
///         the admin clicks "Push to Blockchain". Each game permanently
///         stores its own payload and holds its own funds.
/// @dev UUPS upgradeable long-lived infrastructure.
contract GameFactory is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    bytes32 public constant GAME_CREATOR_ROLE = keccak256("GAME_CREATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address public vrfCoordinator;
    uint256 public vrfSubscriptionId;
    bytes32 public vrfKeyHash;
    uint32 public vrfCallbackGasLimit;
    uint16 public vrfRequestConfirmations;

    address[] private _games;
    mapping(uint256 => address) private _gameById;
    mapping(string => address) private _gameByCode;

    event GameCreated(
        uint256 indexed gameId,
        address indexed gameAddress,
        string gameCode,
        string schemeCode,
        address currency,
        address indexed creator
    );

    error InvalidParam(string reason);
    error GameCodeExists(string gameCode);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    struct InitParams {
        address admin;
        address vrfCoordinator;
        uint256 vrfSubscriptionId;
        bytes32 vrfKeyHash;
        uint32 vrfCallbackGasLimit;
        uint16 vrfRequestConfirmations;
    }

    function initialize(InitParams calldata p) public initializer {
        if (p.admin == address(0) || p.vrfCoordinator == address(0))
            revert InvalidParam("zero address");
        if (p.vrfCallbackGasLimit == 0) revert InvalidParam("callbackGasLimit must be > 0");

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(GAME_CREATOR_ROLE, p.admin);
        _grantRole(PAUSER_ROLE, p.admin);

        vrfCoordinator = p.vrfCoordinator;
        vrfSubscriptionId = p.vrfSubscriptionId;
        vrfKeyHash = p.vrfKeyHash;
        vrfCallbackGasLimit = p.vrfCallbackGasLimit;
        vrfRequestConfirmations = p.vrfRequestConfirmations;
    }

    /// @notice Deploys a game from the admin payload — any scheme shape, any
    ///         mode, any currency. gameAdmin (normally the API operator
    ///         wallet) receives operator rights on the new game.
    function createGame(
        GameCore.GameConfig calldata cfg,
        GameCore.RankConfig[] calldata ranks,
        address gameAdmin
    ) external onlyRole(GAME_CREATOR_ROLE) whenNotPaused returns (address gameAddress) {
        if (_gameByCode[cfg.gameCode] != address(0)) revert GameCodeExists(cfg.gameCode);

        uint256 newId = _games.length;

        GameCore.VRFConfig memory vrf = GameCore.VRFConfig({
            vrfCoordinator: vrfCoordinator,
            subscriptionId: vrfSubscriptionId,
            keyHash: vrfKeyHash,
            callbackGasLimit: vrfCallbackGasLimit,
            requestConfirmations: vrfRequestConfirmations
        });

        GameCore game = new GameCore(newId, gameAdmin, vrf, cfg, ranks);
        gameAddress = address(game);

        _games.push(gameAddress);
        _gameById[newId] = gameAddress;
        _gameByCode[cfg.gameCode] = gameAddress;

        emit GameCreated(newId, gameAddress, cfg.gameCode, cfg.schemeCode, cfg.currency, msg.sender);
    }

    function getGameCount() external view returns (uint256) { return _games.length; }
    function getGame(uint256 id) external view returns (address) { return _gameById[id]; }
    function getGameByCode(string calldata code) external view returns (address) { return _gameByCode[code]; }
    function getAllGames() external view returns (address[] memory) { return _games; }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
