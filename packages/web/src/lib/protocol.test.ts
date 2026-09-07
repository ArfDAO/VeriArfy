import { describe, expect, it, vi } from "vitest";

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  class MockContract {
    disclosureRequest = vi.fn().mockResolvedValue({
      requester: "0xresearcher",
      snapshotCount: 2n,
      approvals: 1n,
    });
    isDisclosureFinalized = vi.fn().mockResolvedValue(true);
    isDisclosureRevoked = vi.fn().mockResolvedValue(false);
    isDisclosureGranted = vi.fn().mockResolvedValue(false);
    requiredApprovals = vi.fn().mockResolvedValue(1n);
    disclosureSnpIds = vi.fn().mockResolvedValue([1n, 3n]);
    disclosureMetricIds = vi.fn().mockResolvedValue([2n]);
    challengeWindowEnd = vi.fn().mockResolvedValue(90n);
    constructor(_address: string, _abi: unknown, _runner: unknown) {}
  }
  return { ...actual, Contract: MockContract };
});

import { readDisclosure } from "./protocol";

describe("readDisclosure", () => {
  it("uses a connected signer's provider for the block read", async () => {
    const provider = { getBlockNumber: vi.fn().mockResolvedValue(100) };
    const signer = { signMessage: vi.fn(), provider };

    const state = await readDisclosure(signer as never, 7, 1);

    expect(provider.getBlockNumber).toHaveBeenCalledOnce();
    expect(state.currentBlock).toBe(100);
    expect(state.canExecute).toBe(true);
  });

  it("rejects a disconnected signer clearly", async () => {
    const signer = { signMessage: vi.fn(), provider: null };

    await expect(readDisclosure(signer as never, 7, 1)).rejects.toThrow(
      "Cüzdan sağlayıcısı bağlı değil",
    );
  });
});
