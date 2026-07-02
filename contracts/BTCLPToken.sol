// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title BTCLPToken
/// @notice Governance and utility token for the btclottery.io platform.
///         Supports gasless approvals (ERC20Permit) and on-chain voting
///         power delegation (ERC20Votes) for future DAO Governor use.
/// @dev Intentionally NOT upgradeable — token contracts are conventionally
///      immutable to preserve holder trust. Max supply is hard-capped and
///      enforced on every mint; minting is restricted to MINTER_ROLE.
contract BTCLPToken is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes, AccessControl {

    /// @notice Role permitted to mint new tokens, up to MAX_SUPPLY.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Hard cap on total supply — 100,000,000 BTCLP (18 decimals).
    uint256 public constant MAX_SUPPLY = 100_000_000 * 10 ** 18;

    error ExceedsMaxSupply();
    error ZeroAddress();

    /// @param admin Address granted DEFAULT_ADMIN_ROLE and MINTER_ROLE.
    constructor(address admin)
        ERC20("BTC Lottery Token", "BTCLP")
        ERC20Permit("BTC Lottery Token")
    {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mints new tokens, up to MAX_SUPPLY. Restricted to MINTER_ROLE.
    /// @param to     Recipient address.
    /// @param amount Amount to mint (in wei, 18 decimals).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (totalSupply() + amount > MAX_SUPPLY) revert ExceedsMaxSupply();
        _mint(to, amount);
    }

    // ─── Required overrides (multiple inheritance resolution) ────────────────

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
