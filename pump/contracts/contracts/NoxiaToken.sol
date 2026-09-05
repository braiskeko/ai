// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title NoxiaToken
 * @notice Plain, fixed-supply ERC-20 launched through the Noxia launchpad.
 *
 * The whole supply is minted once at construction: the creator's allocation goes to
 * the creator, everything else to the launchpad, which sells it on the bonding curve
 * and later seeds the Uniswap pool. There is no owner, no mint function, no tax and
 * no transfer restriction — after launch the token is fully independent.
 */
contract NoxiaToken is ERC20, ERC20Burnable, ERC20Permit {
    /// @notice The launchpad that created this token.
    address public immutable launchpad;
    /// @notice Address that created the token through the launchpad.
    address public immutable creator;
    /// @notice Off-chain metadata (image, description, links) — a JSON document.
    string public metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        uint256 totalSupply_,
        uint256 creatorAmount
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        require(creatorAmount <= totalSupply_, "allocation > supply");
        launchpad = msg.sender;
        creator = creator_;
        metadataURI = metadataURI_;
        if (creatorAmount > 0) _mint(creator_, creatorAmount);
        _mint(msg.sender, totalSupply_ - creatorAmount);
    }
}
