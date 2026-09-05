import { expect } from "chai";

import {
  D15_PROFILE_ID,
  loadD15Profile,
  parseD15NodeRole,
  parseD15Profile,
} from "../scripts/d15-profile";

const valid = {
  profile: D15_PROFILE_ID,
  network: "sepolia",
  chainId: 11155111,
  publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  deployer: "0x836091aB39884BB57DB4Dd94Ee120286Ad7e4fe0",
  authorizedNodes: [
    "0x26E2b3a873B057E50f4caC0D3efA9489dEF93208",
    "0x7c8cbfdD76Ee47425CAf33aBF663509cE7A602fe",
  ],
  queryType: 2,
  minParticipants: 1,
  nodeBaseStakeWei: "1000000000000000",
  minimumDeployerBalanceWei: "20000000000000000",
};

describe("D15 public Sepolia profile", () => {
  it("approved two-node ML profile'ini canonical parse eder", () => {
    const profile = parseD15Profile(valid);
    expect(profile.profile).to.equal(D15_PROFILE_ID);
    expect(profile.authorizedNodes).to.deep.equal(valid.authorizedNodes);
    expect(profile.queryType).to.equal(2);
    expect(profile.minParticipants).to.equal(1);
    expect(loadD15Profile()).to.deep.equal(profile);
  });

  it("deployer/node cakismasini ve duplicate node'u reddeder", () => {
    expect(() =>
      parseD15Profile({ ...valid, deployer: valid.authorizedNodes[0] }),
    ).to.throw();
    expect(() =>
      parseD15Profile({
        ...valid,
        authorizedNodes: [valid.authorizedNodes[0], valid.authorizedNodes[0]],
      }),
    ).to.throw();
  });

  it("yanlis ag, sorgu, katilimci ve stake degerlerini reddeder", () => {
    expect(() => parseD15Profile({ ...valid, chainId: 1 })).to.throw();
    expect(() => parseD15Profile({ ...valid, queryType: 4 })).to.throw();
    expect(() => parseD15Profile({ ...valid, minParticipants: 10 })).to.throw();
    expect(() => parseD15Profile({ ...valid, nodeBaseStakeWei: "0" })).to.throw();
    expect(() => parseD15Profile({ ...valid, publicRpcUrl: "http://localhost" })).to.throw();
    expect(() =>
      parseD15Profile({ ...valid, publicRpcUrl: "https://example.com" }),
    ).to.throw("canonical endpoint");
  });

  it("yalniz node-1 ve node-2 rollerini kabul eder", () => {
    expect(parseD15NodeRole("node-1")).to.equal("node-1");
    expect(parseD15NodeRole(" node-2 ")).to.equal("node-2");
    expect(() => parseD15NodeRole("node-3")).to.throw();
    expect(() => parseD15NodeRole(undefined)).to.throw();
  });
});
