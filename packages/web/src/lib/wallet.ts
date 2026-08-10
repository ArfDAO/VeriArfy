import { BrowserProvider, type Eip1193Provider } from "ethers";

import { SEPOLIA_CHAIN_ID, SEPOLIA_HEX } from "../config";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (event: string, handler: (...args: any[]) => void) => void;
      removeListener?: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}

export function hasWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectWallet(): Promise<{
  provider: BrowserProvider;
  address: string;
  chainId: number;
}> {
  if (!hasWallet()) {
    throw new Error("Bir Ethereum cuzdani bulunamadi (MetaMask vb.).");
  }
  const provider = new BrowserProvider(window.ethereum!);
  const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
  const net = await provider.getNetwork();
  return { provider, address: accounts[0], chainId: Number(net.chainId) };
}

/** Cuzdani Sepolia'ya gecirir; ag ekli degilse eklemeyi dener. */
export async function ensureSepolia(): Promise<void> {
  if (!hasWallet()) throw new Error("Cuzdan yok.");
  try {
    await window.ethereum!.request?.({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (err: any) {
    if (err?.code === 4902) {
      await window.ethereum!.request?.({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: SEPOLIA_HEX,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export function isSepolia(chainId: number): boolean {
  return chainId === SEPOLIA_CHAIN_ID;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
