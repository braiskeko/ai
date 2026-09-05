// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal stand-ins for the parts of Uniswap V2 the launchpad touches. Test only.
contract MockWETH {
    string public name = "Wrapped Ether";
}

contract MockPair {
    address public token0;
    address public token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }
}

contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        pair = address(new MockPair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract MockUniswapV2Router {
    MockUniswapV2Factory public immutable factoryContract;
    address public immutable WETH;
    bool public shouldRevert;
    /// @dev simulate a router that only takes part of the ETH (existing pool at another ratio)
    uint256 public ethTakeBps = 10_000;

    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;
    address public lastTo;

    constructor() {
        factoryContract = new MockUniswapV2Factory();
        WETH = address(new MockWETH());
    }

    function factory() external view returns (address) {
        return address(factoryContract);
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setEthTakeBps(uint256 bps) external {
        ethTakeBps = bps;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(!shouldRevert, "MockRouter: forced failure");
        amountETH = (msg.value * ethTakeBps) / 10_000;
        amountToken = (amountTokenDesired * ethTakeBps) / 10_000;
        require(amountToken >= amountTokenMin && amountETH >= amountETHMin, "MockRouter: INSUFFICIENT_AMOUNT");
        IERC20(token).transferFrom(msg.sender, address(this), amountToken);
        if (msg.value > amountETH) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - amountETH}("");
            require(ok, "refund failed");
        }
        if (factoryContract.getPair(token, WETH) == address(0)) factoryContract.createPair(token, WETH);
        lastTokenAmount = amountToken;
        lastEthAmount = amountETH;
        lastTo = to;
        liquidity = amountToken + amountETH;
    }

    receive() external payable {}
}

/// @dev A wallet that refuses ETH, to exercise the pending-creator-fee path.
contract RejectingWallet {
    receive() external payable {
        revert("no thanks");
    }

    function create(address launchpad, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = launchpad.call{value: msg.value}(data);
        require(ok, "create failed");
        return ret;
    }

    function claim(address launchpad) external {
        (bool ok, ) = launchpad.call(abi.encodeWithSignature("claimCreatorFees()"));
        require(ok, "claim failed");
    }
}
