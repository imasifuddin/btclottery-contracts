// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title Lottery
/// @notice Minimal placeholder for a single lottery draw instance.
/// @dev This is a temporary stub deployed by LotteryFactory to prove the
///      factory/registry pattern end-to-end. Full ticket sale, prize pool,
///      and winner selection logic will be added in a future iteration.
///      This contract is intentionally NOT upgradeable: individual draws
///      are short-lived and disposable, unlike the factory itself.
contract Lottery {
    /// @notice Address of the LotteryFactory that deployed this instance.
    address public immutable factory;

    /// @notice Sequential ID assigned by the factory at creation time.
    uint256 public immutable lotteryId;

    constructor(address _factory, uint256 _lotteryId) {
        require(_factory != address(0), "Lottery: factory is zero address");
        factory = _factory;
        lotteryId = _lotteryId;
    }
}
