// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TicketNFT
/// @notice Each lottery ticket is minted as an NFT with off-chain metadata
///         (IPFS). Minting is restricted to authorized LotteryCore instances
///         via MINTER_ROLE. Tickets are burned after their draw completes.
/// @dev Intentionally NOT upgradeable. One TicketNFT contract serves all
///      lotteries platform-wide; individual LotteryCore instances are
///      granted MINTER_ROLE by an admin after deployment.
contract TicketNFT is ERC721, ERC721Burnable, AccessControl {

    /// @notice Role permitted to mint tickets — granted to LotteryCore instances.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Auto-incrementing token ID counter.
    uint256 private _nextTokenId;

    /// @notice tokenId => lotteryId this ticket belongs to.
    mapping(uint256 => uint256) public ticketLotteryId;

    /// @notice tokenId => IPFS metadata URI.
    mapping(uint256 => string) private _tokenURIs;

    event TicketMinted(uint256 indexed tokenId, uint256 indexed lotteryId, address indexed buyer);

    error ZeroAddress();
    error TokenDoesNotExist();

    /// @param admin Address granted DEFAULT_ADMIN_ROLE (can grant MINTER_ROLE to LotteryCore instances).
    constructor(address admin) ERC721("btclottery.io Ticket", "BTCLTKT") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Mints a new ticket NFT. Restricted to authorized LotteryCore instances.
    /// @param to        Buyer's address.
    /// @param lotteryId  ID of the lottery this ticket belongs to.
    /// @param metadataURI IPFS URI for this ticket's metadata.
    /// @return tokenId The newly minted token ID.
    function mintTicket(
        address to,
        uint256 lotteryId,
        string calldata metadataURI
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();

        tokenId = _nextTokenId++;
        ticketLotteryId[tokenId] = lotteryId;
        _tokenURIs[tokenId] = metadataURI;

        _safeMint(to, tokenId);

        emit TicketMinted(tokenId, lotteryId, to);
    }

    /// @notice Returns the metadata URI for a given ticket.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    /// @notice Returns total tickets minted across all lotteries.
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    // ─── Required override (multiple inheritance resolution) ─────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
