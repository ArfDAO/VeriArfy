import { describe, expect, it, vi } from "vitest";

import { SEPOLIA_HEX } from "../config";
import { ensureSepolia, type WalletProvider } from "./wallet";

function providerWith(request: ReturnType<typeof vi.fn>): WalletProvider {
  return { request } as unknown as WalletProvider;
}

describe("ensureSepolia", () => {
  it("Sepolia zaten ekliyse dogrudan ona gecer", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    await ensureSepolia(providerWith(request));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
  });

  it("bilinmeyen zinciri ekledikten sonra mutlaka tekrar Sepolia'ya gecer", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce({ code: 4902 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    await ensureSepolia(providerWith(request));
    expect(request.mock.calls.map(([call]) => call.method)).toEqual([
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(request.mock.calls[2][0]).toEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
  });
});
