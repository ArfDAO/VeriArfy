import { expect } from "chai";
import { ethers } from "hardhat";

describe("E/19 fixed-panel payment adapter", () => {
  const BASE_FEE = 100n;
  const PER_RECORD_FEE = 10n;
  const LIQUIDITY_SHARE_BPS = 8_000;
  const MAX_SCARCITY_BPS = 50_000;

  async function fixture() {
    const [owner, researcher, alice, bob, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("StableTestToken");
    const token = await Token.deploy(await owner.getAddress());
    const Protocol = await ethers.getContractFactory("E19PaymentsProtocolHarness");
    const protocol = await Protocol.deploy();
    const Aggregate = await ethers.getContractFactory("E19PaymentsAggregateHarness");
    const aggregate = await Aggregate.deploy();
    const Registry = await ethers.getContractFactory("E19PaymentsRegistryHarness");
    const registry = await Registry.deploy();
    const Payments = await ethers.getContractFactory("VeriarfyE19Payments");
    const payments = await Payments.deploy(
      await owner.getAddress(),
      await protocol.getAddress(),
      await aggregate.getAddress(),
      await token.getAddress(),
      await registry.getAddress(),
      BASE_FEE,
      PER_RECORD_FEE,
      LIQUIDITY_SHARE_BPS,
      MAX_SCARCITY_BPS,
    );

    await protocol.setGateway(await payments.getAddress());
    await protocol.setParticipantCount(3);
    await protocol.setParticipant(await alice.getAddress(), 1);
    await protocol.setParticipant(await bob.getAddress(), 2);
    await protocol.setParticipant(await outsider.getAddress(), 3);
    await aggregate.setEndpointCount(2);
    // Her gerçek E/19 katkısı bütün sabit paneli gönderir: iki endpointte de iki katkı.
    await aggregate.setCoverage(0, 2);
    await aggregate.setCoverage(1, 2);
    await aggregate.setContributed(await alice.getAddress(), true);
    await aggregate.setContributed(await bob.getAddress(), true);
    await registry.setRegistered(await researcher.getAddress(), true);
    await token.mint(await researcher.getAddress(), 1_000);
    await token.connect(researcher).approve(await payments.getAddress(), ethers.MaxUint256);
    return { owner, researcher, alice, bob, outsider, token, protocol, aggregate, registry, payments };
  }

  it("prices each frozen endpoint, escrows payment, and opens the exact E/19 gateway request", async () => {
    const { researcher, payments, protocol, token } = await fixture();
    // pool=3, coverage=2 => scarcity 1.5x. endpoint price = 10 * 2 * 1.5 = 30.
    expect(await payments.quote()).to.deep.equal([160n, 4n, 60_000n]);
    expect(await payments.quoteEndpoint(0)).to.deep.equal([2n, 15_000n, 30n]);
    await expect(payments.quoteEndpoint(2))
      .to.be.revertedWithCustomError(payments, "InvalidEndpoint")
      .withArgs(2);

    await expect(payments.connect(researcher).openQuery())
      .to.emit(payments, "QueryOpened")
      .withArgs(0, await researcher.getAddress(), 160n, 3);

    const query = await payments.query();
    expect(query.fee).to.equal(160n);
    expect(query.coverageTotal).to.equal(4n);
    expect(query.weightedTotal).to.equal(60_000n);
    expect(await payments.queryFieldCoverage(0)).to.equal(2n);
    expect(await payments.queryFieldScarcityBps(1)).to.equal(15_000n);
    expect(await token.balanceOf(await payments.getAddress())).to.equal(160n);
    const request = await protocol.aggregateRequest();
    expect(request.researcher).to.equal(await researcher.getAddress());
    expect(request.snapshotCount).to.equal(3n);
  });

  it("never settles before the real aggregate output is granted, then pays only frozen-panel contributors", async () => {
    const { owner, researcher, alice, bob, outsider, payments, protocol, token } = await fixture();
    await payments.connect(researcher).openQuery();
    await expect(payments.settleQuery()).to.be.revertedWithCustomError(payments, "OutputNotGranted");

    await protocol.setGranted(true);
    await expect(payments.connect(outsider).settleQuery())
      .to.emit(payments, "QuerySettled")
      .withArgs(0, 128n, 32n);
    expect(await payments.claimable(await alice.getAddress())).to.equal(64n);
    expect(await payments.claimable(await bob.getAddress())).to.equal(64n);
    expect(await payments.claimable(await outsider.getAddress())).to.equal(0n);

    await expect(payments.connect(outsider).claim())
      .to.be.revertedWithCustomError(payments, "NotContributor");
    await expect(payments.connect(alice).claim()).to.emit(payments, "RewardClaimed").withArgs(0, await alice.getAddress(), 64n);
    await expect(payments.connect(bob).claim()).to.emit(payments, "RewardClaimed").withArgs(0, await bob.getAddress(), 64n);
    expect(await token.balanceOf(await alice.getAddress())).to.equal(64n);
    expect(await token.balanceOf(await bob.getAddress())).to.equal(64n);
    expect((await payments.query()).claimedTotal).to.equal(128n);
    await expect(payments.connect(alice).claim()).to.be.revertedWithCustomError(payments, "AlreadyClaimed");

    await expect(payments.connect(owner).withdrawTreasury(await owner.getAddress()))
      .to.emit(payments, "TreasuryWithdrawn")
      .withArgs(await owner.getAddress(), 32n);
  });

  it("rejects an unregistered researcher and preserves the single-query E/19 boundary", async () => {
    const { researcher, outsider, payments, protocol } = await fixture();
    await expect(payments.connect(outsider).openQuery())
      .to.be.revertedWithCustomError(payments, "NotRegisteredResearcher");
    expect((await protocol.aggregateRequest()).researcher).to.equal(ethers.ZeroAddress);

    await payments.connect(researcher).openQuery();
    await expect(payments.connect(researcher).openQuery())
      .to.be.revertedWithCustomError(payments, "QueryAlreadyOpened");
  });

  it("rolls the aggregate request back when the fixed panel has no covered records", async () => {
    const { researcher, aggregate, payments, protocol } = await fixture();
    await aggregate.setCoverage(0, 0);
    await aggregate.setCoverage(1, 0);
    await expect(payments.connect(researcher).openQuery())
      .to.be.revertedWithCustomError(payments, "NoCoveredFields");
    expect((await protocol.aggregateRequest()).researcher).to.equal(ethers.ZeroAddress);
  });
});
