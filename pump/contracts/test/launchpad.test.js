const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = ethers.parseEther;
const VIRTUAL_ETH = E("1.8"); // launch virtual reserve used in tests
const BPS = 10_000n;
const FEE_BPS = 270n;
const TOTAL = E("1000000000");
const CURVE = E("793100000");
const RESERVE = TOTAL - CURVE;
const VT = E("1073000000");

async function deploy() {
  const [owner, treasury, alice, bob, carol] = await ethers.getSigners();
  const Router = await ethers.getContractFactory("MockUniswapV2Router");
  const router = await Router.deploy();
  const Launchpad = await ethers.getContractFactory("NoxiaLaunchpad");
  const pad = await Launchpad.deploy(await router.getAddress(), treasury.address, VIRTUAL_ETH);
  return { owner, treasury, alice, bob, carol, router, pad };
}

async function createToken(pad, signer, opts = {}) {
  const tx = await pad
    .connect(signer)
    .create(opts.name ?? "Noxia Cat", opts.symbol ?? "NCAT", opts.uri ?? "https://app.noxia.work/api/meta/x.json", opts.allocBps ?? 0, 0, {
      value: opts.value ?? 0n,
    });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenCreated");
  const token = await ethers.getContractAt("NoxiaToken", ev.args.token);
  return { token, address: ev.args.token, event: ev };
}

const curveOf = async (pad, addr) => {
  const c = await pad.curves(addr);
  return { creator: c.creator, realEth: c.realEth, realTokens: c.realTokens, virtualEth: c.virtualEth, virtualTokens: c.virtualTokens, graduated: c.graduated, pending: c.graduationPending };
};

describe("NoxiaLaunchpad", () => {
  describe("creation", () => {
    it("mints the full supply: creator allocation to the creator, the rest to the launchpad", async () => {
      const { pad, alice } = await loadFixture(deploy);
      const { token, address, event } = await createToken(pad, alice, { allocBps: 500 });
      expect(await token.totalSupply()).to.equal(TOTAL);
      const alloc = (TOTAL * 500n) / BPS;
      expect(await token.balanceOf(alice.address)).to.equal(alloc);
      expect(await token.balanceOf(await pad.getAddress())).to.equal(TOTAL - alloc);
      expect(await token.creator()).to.equal(alice.address);
      expect(await token.launchpad()).to.equal(await pad.getAddress());
      expect(event.args.curveSupply).to.equal(CURVE - alloc);
      const c = await curveOf(pad, address);
      expect(c.realTokens).to.equal(CURVE - alloc);
      expect(c.virtualTokens).to.equal(VT - alloc);
      expect(c.virtualEth).to.equal(VIRTUAL_ETH);
      expect(await pad.tokenCount()).to.equal(1n);
    });

    it("rejects allocations above 30%, bad names and paused creation", async () => {
      const { pad, alice, owner } = await loadFixture(deploy);
      await expect(pad.connect(alice).create("X", "X", "", 3001, 0)).to.be.revertedWithCustomError(pad, "InvalidParams");
      await expect(pad.connect(alice).create("", "X", "", 0, 0)).to.be.revertedWithCustomError(pad, "InvalidParams");
      await expect(pad.connect(alice).create("X", "TOOLONGTICKER", "", 0, 0)).to.be.revertedWithCustomError(pad, "InvalidParams");
      await pad.connect(owner).setCreationPaused(true);
      await expect(pad.connect(alice).create("X", "X", "", 0, 0)).to.be.revertedWithCustomError(pad, "Paused");
    });

    it("launch price and market cap follow the virtual reserves", async () => {
      const { pad, alice } = await loadFixture(deploy);
      const { address } = await createToken(pad, alice);
      const price = await pad.price(address);
      expect(price).to.equal((VIRTUAL_ETH * E("1")) / VT);
      expect(await pad.marketCap(address)).to.equal((VIRTUAL_ETH * TOTAL) / VT);
    });

    it("spends msg.value as the creator's first buy", async () => {
      const { pad, alice } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice, { value: E("0.1") });
      expect(await token.balanceOf(alice.address)).to.be.gt(0n);
      const c = await curveOf(pad, address);
      const fee = (E("0.1") * FEE_BPS) / BPS;
      expect(c.realEth).to.equal(E("0.1") - fee);
    });
  });

  describe("trading", () => {
    it("buy charges 2.7%, splits the fee 10/90 and raises the price; sell lowers it", async () => {
      const { pad, alice, bob, treasury } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice);
      const p0 = await pad.price(address);
      const [quoteTokens, quoteFee] = await pad.quoteBuy(address, E("1"));
      const aliceBefore = await ethers.provider.getBalance(alice.address);
      await expect(pad.connect(bob).buy(address, quoteTokens, { value: E("1") }))
        .to.emit(pad, "Trade")
        .withArgs(address, bob.address, true, E("1"), quoteTokens, quoteFee, (v) => v > 0n, (v) => v > 0n, VIRTUAL_ETH, (v) => v > 0n);
      expect(await token.balanceOf(bob.address)).to.equal(quoteTokens);
      expect(quoteFee).to.equal((E("1") * FEE_BPS) / BPS);
      // creator got 10% of the fee pushed straight to their wallet
      expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(quoteFee / 10n);
      expect(await pad.treasuryFees()).to.equal(quoteFee - quoteFee / 10n);
      const p1 = await pad.price(address);
      expect(p1).to.be.gt(p0);

      // sell half
      const half = quoteTokens / 2n;
      const [ethOut, sellFee] = await pad.quoteSell(address, half);
      await token.connect(bob).approve(await pad.getAddress(), half);
      const bobBefore = await ethers.provider.getBalance(bob.address);
      const tx = await pad.connect(bob).sell(address, half, ethOut);
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      expect((await ethers.provider.getBalance(bob.address)) - bobBefore + gas).to.equal(ethOut);
      expect(sellFee).to.be.gt(0n);
      expect(await pad.price(address)).to.be.lt(p1);

      // treasury can pull its fees
      const owed = await pad.treasuryFees();
      const tBefore = await ethers.provider.getBalance(treasury.address);
      await pad.connect(bob).withdrawTreasuryFees();
      expect((await ethers.provider.getBalance(treasury.address)) - tBefore).to.equal(owed);
      expect(await pad.treasuryFees()).to.equal(0n);
    });

    it("round trip returns less than paid (two fees) and restores the curve", async () => {
      const { pad, alice, bob } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice);
      const before = await curveOf(pad, address);
      await pad.connect(bob).buy(address, 0, { value: E("0.5") });
      const got = await token.balanceOf(bob.address);
      await token.connect(bob).approve(await pad.getAddress(), got);
      const [ethOut] = await pad.quoteSell(address, got);
      expect(ethOut).to.be.lt(E("0.5"));
      expect(ethOut).to.be.gte((E("0.5") * (BPS - FEE_BPS) * (BPS - FEE_BPS)) / BPS / BPS - 10n);
      await pad.connect(bob).sell(address, got, ethOut);
      const after = await curveOf(pad, address);
      expect(after.realTokens).to.equal(before.realTokens);
      expect(after.virtualTokens).to.equal(before.virtualTokens);
      expect(after.realEth).to.be.lte(2n); // rounding dust only
    });

    it("enforces slippage limits", async () => {
      const { pad, alice, bob } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice);
      const [q] = await pad.quoteBuy(address, E("1"));
      await expect(pad.connect(bob).buy(address, q + 1n, { value: E("1") })).to.be.revertedWithCustomError(pad, "Slippage");
      await pad.connect(bob).buy(address, q, { value: E("1") });
      const bal = await token.balanceOf(bob.address);
      await token.connect(bob).approve(await pad.getAddress(), bal);
      const [out] = await pad.quoteSell(address, bal);
      await expect(pad.connect(bob).sell(address, bal, out + 1n)).to.be.revertedWithCustomError(pad, "Slippage");
    });

    it("rejects unknown tokens and zero amounts", async () => {
      const { pad, bob } = await loadFixture(deploy);
      await expect(pad.connect(bob).buy(bob.address, 0, { value: E("1") })).to.be.revertedWithCustomError(pad, "UnknownToken");
      const { address } = await createToken(pad, bob);
      await expect(pad.connect(bob).buy(address, 0, { value: 0 })).to.be.revertedWithCustomError(pad, "ZeroAmount");
      await expect(pad.connect(bob).sell(address, 0, 0)).to.be.revertedWithCustomError(pad, "ZeroAmount");
    });

    it("keeps creator fees claimable when the creator's wallet rejects ETH", async () => {
      const { pad, bob } = await loadFixture(deploy);
      const Rejecting = await ethers.getContractFactory("RejectingWallet");
      const wallet = await Rejecting.deploy();
      const data = pad.interface.encodeFunctionData("create", ["Rej", "REJ", "", 0, 0]);
      const tx = await wallet.create(await pad.getAddress(), data);
      await tx.wait();
      const tokenAddr = await pad.allTokens(0);
      await pad.connect(bob).buy(tokenAddr, 0, { value: E("1") });
      const fee = (E("1") * FEE_BPS) / BPS;
      expect(await pad.pendingCreatorFees(await wallet.getAddress())).to.equal(fee / 10n);
      // The claim itself is pushed with mustSucceed, so a wallet that still rejects ETH cannot claim.
      await expect(wallet.claim(await pad.getAddress())).to.be.reverted;
    });
  });

  describe("graduation", () => {
    it("sells out, refunds excess ETH, seeds Uniswap at the final price, burns LP + leftover and closes the curve", async () => {
      const { pad, alice, bob, carol, router } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice);
      const need = await pad.ethToGraduate(address);
      // pump.fun proportions: ≈ 2.83 × virtual ETH to sell out
      expect(need).to.be.closeTo((VIRTUAL_ETH * 2834n) / 1000n / ((BPS - FEE_BPS)) * BPS, E("0.05"));

      await pad.connect(bob).buy(address, 0, { value: need / 2n });
      const carolBefore = await ethers.provider.getBalance(carol.address);
      const overpay = need; // way more than the remaining half
      const tx = await pad.connect(carol).buy(address, 0, { value: overpay });
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      const spent = carolBefore - (await ethers.provider.getBalance(carol.address)) - gas;
      expect(spent).to.be.lt(overpay); // refunded the excess
      expect(spent).to.be.closeTo(need - need / 2n, E("0.001"));

      const c = await curveOf(pad, address);
      expect(c.graduated).to.equal(true);
      expect(c.pending).to.equal(false);
      expect(c.realTokens).to.equal(0n);
      expect(c.realEth).to.equal(0n);

      // pool got all the curve ETH and tokens priced at the final curve price
      const ethToPool = await router.lastEthAmount();
      const tokensToPool = await router.lastTokenAmount();
      expect(await router.lastTo()).to.equal("0x000000000000000000000000000000000000dEaD");
      const finalPrice = ((ethToPool + VIRTUAL_ETH) * E("1")) / c.virtualTokens;
      const poolPrice = (ethToPool * E("1")) / tokensToPool;
      expect(poolPrice).to.be.closeTo(finalPrice, finalPrice / 1000n);
      expect(tokensToPool).to.be.lte(RESERVE);
      // launchpad holds no tokens anymore; leftover reserve burned
      expect(await token.balanceOf(await pad.getAddress())).to.equal(0n);
      expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(RESERVE - tokensToPool);
      // curve closed
      await expect(pad.connect(bob).buy(address, 0, { value: E("0.1") })).to.be.revertedWithCustomError(pad, "CurveClosed");
      await expect(pad.connect(bob).graduate(address)).to.be.revertedWithCustomError(pad, "NothingToDo");
      // launchpad ETH balance == outstanding fees only
      const fees = await pad.treasuryFees();
      const pending = 0n;
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.equal(fees + pending);
    });

    it("keeps the curve closed and retryable when the Uniswap step fails", async () => {
      const { pad, alice, bob, router } = await loadFixture(deploy);
      const { address } = await createToken(pad, alice);
      await router.setShouldRevert(true);
      const need = await pad.ethToGraduate(address);
      await expect(pad.connect(bob).buy(address, 0, { value: need + E("0.01") })).to.emit(pad, "GraduationFailed");
      let c = await curveOf(pad, address);
      expect(c.pending).to.equal(true);
      expect(c.graduated).to.equal(false);
      await expect(pad.connect(bob).buy(address, 0, { value: E("0.1") })).to.be.revertedWithCustomError(pad, "CurveClosed");
      await router.setShouldRevert(false);
      await expect(pad.connect(bob).graduate(address)).to.emit(pad, "Graduated");
      c = await curveOf(pad, address);
      expect(c.graduated).to.equal(true);
      expect(c.pending).to.equal(false);
    });

    it("credits ETH the router hands back to the treasury", async () => {
      const { pad, alice, bob, router } = await loadFixture(deploy);
      const { address } = await createToken(pad, alice);
      await router.setEthTakeBps(9950); // router pairs only 99.5% of the ETH
      const need = await pad.ethToGraduate(address);
      const feesBefore = await pad.treasuryFees();
      await pad.connect(bob).buy(address, 0, { value: need + E("0.01") });
      const c = await curveOf(pad, address);
      expect(c.graduated).to.equal(true);
      expect(await pad.treasuryFees()).to.be.gt(feesBefore);
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.equal(await pad.treasuryFees());
    });

    it("works with the maximum creator allocation", async () => {
      const { pad, alice, bob } = await loadFixture(deploy);
      const { token, address } = await createToken(pad, alice, { allocBps: 3000 });
      const need = await pad.ethToGraduate(address);
      await pad.connect(bob).buy(address, 0, { value: need + E("0.01") });
      const c = await curveOf(pad, address);
      expect(c.graduated).to.equal(true);
      expect(await token.balanceOf(await pad.getAddress())).to.equal(0n);
      const dead = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
      const bobBal = await token.balanceOf(bob.address);
      const aliceBal = await token.balanceOf(alice.address);
      const pool = await token.balanceOf(await (await ethers.getContractFactory("MockUniswapV2Router")).attach(await pad.router()).getAddress());
      expect(dead + bobBal + aliceBal + pool).to.equal(TOTAL);
    });
  });

  describe("admin", () => {
    it("owner-only settings", async () => {
      const { pad, owner, alice } = await loadFixture(deploy);
      await expect(pad.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(pad, "OwnableUnauthorizedAccount");
      await pad.connect(owner).setTreasury(alice.address);
      expect(await pad.treasury()).to.equal(alice.address);
      await pad.connect(owner).setLaunchVirtualEth(E("2"));
      expect(await pad.launchVirtualEth()).to.equal(E("2"));
      await expect(pad.connect(owner).setLaunchVirtualEth(0)).to.be.revertedWithCustomError(pad, "InvalidParams");
      // existing curves keep their launch reserve; new ones take the new value
      const { address } = await createToken(pad, alice);
      expect((await curveOf(pad, address)).virtualEth).to.equal(E("2"));
    });
  });
});
