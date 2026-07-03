// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Test-only mock NFT for RaffleCore tests. Never deployed to production.
contract MockERC721 is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("Mock NFT", "MOCK") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _safeMint(to, tokenId);
    }
}
