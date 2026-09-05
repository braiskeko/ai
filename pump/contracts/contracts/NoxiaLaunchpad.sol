// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NoxiaToken} from "./NoxiaToken.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "./interfaces/IUniswapV2.sol";

/**
 * @title NoxiaLaunchpad
 * @notice pump.fun-style memecoin launchpad on an EVM chain, quoted in native ETH.
 *
 * Anyone can create a token. The launchpad sells it on a constant-product bonding
 * curve with virtual reserves; every buy and sell pays a 2.7% fee of which 10% goes
 * to the token creator and 90% to the platform treasury. When the curve sells its
 * last token the coin "graduates": all the ETH collected is paired with tokens from
 * the liquidity reserve on Uniswap V2 at the final curve price, the LP tokens are
 * burned and the remaining reserve is burned too. From then on the token trades
 * only on the open market — the launchpad never holds user funds again.
 *
 * Non-custodial: users trade from their own wallets; the launchpad only escrows
 * curve tokens and curve ETH, both of which are algorithmically owned by the curve.
 *
 * Curve:  (E + vE) · (T + vT') = k,  where the virtual token total vT (1.073B) already
 * contains the real supply for sale, exactly like pump.fun. Spot price = ethTotal / tokenTotal.
 */
contract NoxiaLaunchpad is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B tokens, 18 decimals
    /// @dev Tokens sold on the curve when the creator keeps nothing (pump.fun: 793.1M).
    uint256 public constant CURVE_SUPPLY = 793_100_000 ether;
    /// @dev Reserved for the Uniswap pool at graduation (pump.fun: 206.9M).
    uint256 public constant LIQUIDITY_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY;
    /// @dev Virtual token total the curve starts with (pump.fun: 1.073B).
    uint256 public constant VIRTUAL_TOKEN_TOTAL = 1_073_000_000 ether;
    uint256 public constant FEE_BPS = 270; // 2.7 %
    uint256 public constant CREATOR_FEE_SHARE_BPS = 1000; // 10 % of the fee
    uint256 public constant MAX_CREATOR_ALLOCATION_BPS = 3000; // 30 % of supply
    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ---------------------------------------------------------------- storage
    struct Curve {
        address creator;
        uint128 realEth; // ETH held by the curve (wei)
        uint128 realTokens; // tokens still for sale on the curve
        uint128 virtualEth; // launch virtual ETH reserve (frozen per token)
        uint128 virtualTokens; // current virtual token total (VIRTUAL_TOKEN_TOTAL minus tokens sold)
        uint64 createdAt;
        bool graduated;
        bool graduationPending; // sold out but the Uniswap step failed; retry with graduate()
    }

    IUniswapV2Router02 public immutable router;
    address public immutable weth;

    /// @notice Receives 90% of every fee.
    address public treasury;
    /// @notice Virtual ETH reserve applied to tokens created from now on (sets the launch price).
    uint128 public launchVirtualEth;
    /// @notice Global switch for creating new tokens (existing curves keep trading).
    bool public creationPaused;

    mapping(address => Curve) public curves;
    address[] public allTokens;
    /// @notice Fees owed to creators whose wallet rejected the push transfer.
    mapping(address => uint256) public pendingCreatorFees;
    /// @notice Platform fees not yet withdrawn.
    uint256 public treasuryFees;

    // ---------------------------------------------------------------- events
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 creatorAllocation,
        uint256 virtualEth,
        uint256 curveSupply
    );
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount, // buy: ETH paid incl. fee; sell: ETH received net of fee
        uint256 tokenAmount,
        uint256 fee,
        uint256 realEth,
        uint256 realTokens,
        uint256 virtualEth,
        uint256 virtualTokens
    );
    event CreatorFeePaid(address indexed token, address indexed creator, uint256 amount, bool pushed);
    event Graduated(address indexed token, address pair, uint256 ethToPool, uint256 tokensToPool, uint256 tokensBurned);
    event GraduationFailed(address indexed token, bytes reason);
    event TreasuryUpdated(address treasury);
    event LaunchVirtualEthUpdated(uint256 virtualEth);
    event CreationPaused(bool paused);
    event TreasuryFeesWithdrawn(address to, uint256 amount);
    event PendingCreatorFeesClaimed(address indexed creator, uint256 amount);

    error InvalidParams();
    error Paused();
    error UnknownToken();
    error CurveClosed();
    error ZeroAmount();
    error Slippage();
    error NothingToDo();
    error TransferFailed();

    constructor(address router_, address treasury_, uint128 launchVirtualEth_) Ownable(msg.sender) {
        if (router_ == address(0) || treasury_ == address(0) || launchVirtualEth_ == 0) revert InvalidParams();
        router = IUniswapV2Router02(router_);
        weth = IUniswapV2Router02(router_).WETH();
        treasury = treasury_;
        launchVirtualEth = launchVirtualEth_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- creation

    /**
     * @notice Launch a new token. `msg.value`, if any, is spent as the creator's first buy.
     * @param creatorAllocationBps share of the supply minted straight to the creator (0..3000)
     * @param minTokensOut slippage floor for the optional initial buy (0 to skip the check)
     */
    function create(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 creatorAllocationBps,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        if (creationPaused) revert Paused();
        if (bytes(name).length == 0 || bytes(name).length > 32 || bytes(symbol).length == 0 || bytes(symbol).length > 10)
            revert InvalidParams();
        if (creatorAllocationBps > MAX_CREATOR_ALLOCATION_BPS) revert InvalidParams();

        uint256 creatorAmount = (TOTAL_SUPPLY * creatorAllocationBps) / BPS;
        uint256 curveSupply = CURVE_SUPPLY - creatorAmount; // the allocation comes out of the curve, never the pool reserve

        token = address(new NoxiaToken(name, symbol, metadataURI, msg.sender, TOTAL_SUPPLY, creatorAmount));
        allTokens.push(token);

        Curve storage c = curves[token];
        c.creator = msg.sender;
        c.realTokens = uint128(curveSupply);
        c.virtualEth = launchVirtualEth;
        // The virtual total counts the whole for-sale supply plus the phantom reserve.
        c.virtualTokens = uint128(VIRTUAL_TOKEN_TOTAL - creatorAmount);
        c.createdAt = uint64(block.timestamp);

        emit TokenCreated(token, msg.sender, name, symbol, metadataURI, creatorAmount, launchVirtualEth, curveSupply);

        if (msg.value > 0) _buy(token, msg.sender, msg.value, minTokensOut);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Buy `token` with `msg.value` ETH (fee included). Excess ETH is refunded if the curve sells out.
    function buy(address token, uint256 minTokensOut) external payable nonReentrant {
        _buy(token, msg.sender, msg.value, minTokensOut);
    }

    /// @notice Sell `tokenAmount` of `token` back to the curve for ETH (fee deducted from the payout).
    function sell(address token, uint256 tokenAmount, uint256 minEthOut) external nonReentrant {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated || c.graduationPending) revert CurveClosed();
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 ethTotal = uint256(c.realEth) + c.virtualEth;
        uint256 tokTotal = c.virtualTokens;
        uint256 k = ethTotal * tokTotal;
        uint256 grossOut = ethTotal - k / (tokTotal + tokenAmount);
        if (grossOut > c.realEth) grossOut = c.realEth; // the curve can only pay out what it holds
        uint256 fee = (grossOut * FEE_BPS) / BPS;
        uint256 netOut = grossOut - fee;
        if (netOut < minEthOut) revert Slippage();
        if (netOut == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        c.realEth = uint128(c.realEth - grossOut);
        c.realTokens = uint128(uint256(c.realTokens) + tokenAmount);
        c.virtualTokens = uint128(tokTotal + tokenAmount);

        _distributeFee(token, c.creator, fee);
        _sendEth(msg.sender, netOut, true);

        _emitTrade(token, msg.sender, false, netOut, tokenAmount, fee);
    }

    function _buy(address token, address buyer, uint256 ethIn, uint256 minTokensOut) internal {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated || c.graduationPending) revert CurveClosed();
        if (ethIn == 0) revert ZeroAmount();

        uint256 ethTotal = uint256(c.realEth) + c.virtualEth;
        uint256 tokTotal = c.virtualTokens;
        uint256 k = ethTotal * tokTotal;

        uint256 fee = (ethIn * FEE_BPS) / BPS;
        uint256 net = ethIn - fee;
        uint256 tokensOut = tokTotal - k / (ethTotal + net);
        uint256 refund;
        if (tokensOut >= c.realTokens) {
            // Selling out: charge only what the remaining tokens cost, refund the rest.
            tokensOut = c.realTokens;
            uint256 netNeeded = k / (tokTotal - tokensOut) - ethTotal;
            uint256 ethNeeded = (netNeeded * BPS + (BPS - FEE_BPS) - 1) / (BPS - FEE_BPS); // ceil, fee included
            if (ethNeeded < ethIn) {
                refund = ethIn - ethNeeded;
                ethIn = ethNeeded;
                fee = (ethIn * FEE_BPS) / BPS;
                net = ethIn - fee;
            }
        }
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();

        c.realEth = uint128(c.realEth + net);
        c.realTokens = uint128(c.realTokens - tokensOut);
        c.virtualTokens = uint128(tokTotal - tokensOut);

        _distributeFee(token, c.creator, fee);
        IERC20(token).safeTransfer(buyer, tokensOut);
        if (refund > 0) _sendEth(buyer, refund, true);

        _emitTrade(token, buyer, true, ethIn, tokensOut, fee);

        if (c.realTokens == 0) _graduate(token, c);
    }

    function _emitTrade(address token, address trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee) internal {
        Curve storage c = curves[token];
        emit Trade(token, trader, isBuy, ethAmount, tokenAmount, fee, c.realEth, c.realTokens, c.virtualEth, c.virtualTokens);
    }

    // ---------------------------------------------------------------- graduation

    /// @notice Retry the Uniswap step for a sold-out curve whose first attempt failed. Anyone may call.
    function graduate(address token) external nonReentrant {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (!c.graduationPending) revert NothingToDo();
        _graduate(token, c);
    }

    function _graduate(address token, Curve storage c) internal {
        uint256 ethForPool = c.realEth;
        // Pool tokens priced at the final curve price: tokens = eth / price = eth * tokTotal / ethTotal.
        uint256 ethTotal = ethForPool + c.virtualEth;
        uint256 tokensForPool = (ethForPool * c.virtualTokens) / ethTotal;
        if (tokensForPool > LIQUIDITY_RESERVE) tokensForPool = LIQUIDITY_RESERVE;

        IERC20(token).forceApprove(address(router), tokensForPool);
        try
            router.addLiquidityETH{value: ethForPool}(
                token,
                tokensForPool,
                (tokensForPool * 99) / 100,
                (ethForPool * 99) / 100,
                DEAD,
                block.timestamp
            )
        returns (uint256 usedTokens, uint256 usedEth, uint256) {
            IERC20(token).forceApprove(address(router), 0);
            c.graduated = true;
            c.graduationPending = false;
            c.realEth = 0;
            // Anything the router did not take (dust) plus the unused reserve is burned.
            uint256 leftover = IERC20(token).balanceOf(address(this));
            if (leftover > 0) IERC20(token).safeTransfer(DEAD, leftover);
            if (ethForPool > usedEth) {
                // The router refunds ETH it could not pair (rounding, or a pre-existing pool at a
                // slightly different price). It is curve ETH with no owner left, so it goes to the treasury.
                treasuryFees += ethForPool - usedEth;
            }
            address pair = IUniswapV2Factory(router.factory()).getPair(token, weth);
            emit Graduated(token, pair, usedEth, usedTokens, leftover);
        } catch (bytes memory reason) {
            IERC20(token).forceApprove(address(router), 0);
            c.graduationPending = true;
            emit GraduationFailed(token, reason);
        }
    }

    // ---------------------------------------------------------------- fees

    function _distributeFee(address token, address creator, uint256 fee) internal {
        if (fee == 0) return;
        uint256 creatorFee = (fee * CREATOR_FEE_SHARE_BPS) / BPS;
        treasuryFees += fee - creatorFee;
        if (creatorFee == 0) return;
        bool ok = _sendEth(creator, creatorFee, false);
        if (!ok) pendingCreatorFees[creator] += creatorFee;
        emit CreatorFeePaid(token, creator, creatorFee, ok);
    }

    /// @notice Creators whose wallet rejected a fee push can pull it here.
    function claimCreatorFees() external nonReentrant {
        uint256 amount = pendingCreatorFees[msg.sender];
        if (amount == 0) revert NothingToDo();
        pendingCreatorFees[msg.sender] = 0;
        _sendEth(msg.sender, amount, true);
        emit PendingCreatorFeesClaimed(msg.sender, amount);
    }

    /// @notice Send the accumulated platform fees to the treasury. Anyone may trigger it.
    function withdrawTreasuryFees() external nonReentrant {
        uint256 amount = treasuryFees;
        if (amount == 0) revert NothingToDo();
        treasuryFees = 0;
        _sendEth(treasury, amount, true);
        emit TreasuryFeesWithdrawn(treasury, amount);
    }

    function _sendEth(address to, uint256 amount, bool mustSucceed) internal returns (bool ok) {
        (ok, ) = payable(to).call{value: amount, gas: 60_000}("");
        if (!ok && mustSucceed) revert TransferFailed();
    }

    // ---------------------------------------------------------------- admin

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Adjust the launch price for future tokens (e.g. when the ETH price moves a lot).
    function setLaunchVirtualEth(uint128 virtualEth) external onlyOwner {
        if (virtualEth == 0) revert InvalidParams();
        launchVirtualEth = virtualEth;
        emit LaunchVirtualEthUpdated(virtualEth);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    // ---------------------------------------------------------------- views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Spot price in wei per whole token (1e18 units).
    function price(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        return ((uint256(c.realEth) + c.virtualEth) * 1 ether) / c.virtualTokens;
    }

    /// @notice Market cap in wei (spot price × total supply).
    function marketCap(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        return ((uint256(c.realEth) + c.virtualEth) * TOTAL_SUPPLY) / c.virtualTokens;
    }

    /// @notice Tokens received for `ethIn` (fee included) and the fee charged; caps at the remaining supply.
    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 tokensOut, uint256 fee, uint256 ethUsed) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        uint256 ethTotal = uint256(c.realEth) + c.virtualEth;
        uint256 tokTotal = c.virtualTokens;
        uint256 k = ethTotal * tokTotal;
        fee = (ethIn * FEE_BPS) / BPS;
        tokensOut = tokTotal - k / (ethTotal + ethIn - fee);
        ethUsed = ethIn;
        if (tokensOut >= c.realTokens) {
            tokensOut = c.realTokens;
            uint256 netNeeded = k / (tokTotal - tokensOut) - ethTotal;
            uint256 ethNeeded = (netNeeded * BPS + (BPS - FEE_BPS) - 1) / (BPS - FEE_BPS);
            if (ethNeeded < ethIn) {
                ethUsed = ethNeeded;
                fee = (ethNeeded * FEE_BPS) / BPS;
            }
        }
    }

    /// @notice ETH received (net of fee) for selling `tokenAmount`, and the fee.
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 ethOut, uint256 fee) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        uint256 ethTotal = uint256(c.realEth) + c.virtualEth;
        uint256 tokTotal = c.virtualTokens;
        uint256 grossOut = ethTotal - (ethTotal * tokTotal) / (tokTotal + tokenAmount);
        if (grossOut > c.realEth) grossOut = c.realEth;
        fee = (grossOut * FEE_BPS) / BPS;
        ethOut = grossOut - fee;
    }

    /// @notice ETH (fee included) still needed to sell out the curve, i.e. to graduate.
    function ethToGraduate(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.realTokens == 0) return 0;
        uint256 ethTotal = uint256(c.realEth) + c.virtualEth;
        uint256 tokTotal = c.virtualTokens;
        uint256 netNeeded = (ethTotal * tokTotal) / (tokTotal - c.realTokens) - ethTotal;
        return (netNeeded * BPS + (BPS - FEE_BPS) - 1) / (BPS - FEE_BPS);
    }
}
