import { BrowserProvider, type Eip1193Provider } from "ethers";

import { SEPOLIA_CHAIN_ID, SEPOLIA_HEX } from "../config";

export type WalletProvider = Eip1193Provider & {
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  providers?: WalletProvider[];
  isMetaMask?: boolean;
  isTrust?: boolean;
};

export interface WalletOption {
  /** EIP-6963 uuid; legacy saglayicilar icin yerel ve kararli bir kimlik. */
  id: string;
  name: string;
  rdns: string | null;
  provider: WalletProvider;
}

interface Eip6963Detail {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: WalletProvider;
}

declare global {
  interface Window {
    ethereum?: WalletProvider;
  }
}

const FALLBACK_WALLET_ID = "legacy-window-ethereum";

function legacyName(provider: WalletProvider): string {
  if (provider.isMetaMask) return "MetaMask";
  if (provider.isTrust) return "Trust Wallet";
  return "Tarayici cuzdani";
}

function isEip6963Detail(value: unknown): value is Eip6963Detail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<Eip6963Detail>;
  return (
    !!detail.provider &&
    typeof detail.info?.uuid === "string" &&
    typeof detail.info.name === "string" &&
    typeof detail.info.rdns === "string"
  );
}

/** Eski `window.ethereum` entegrasyonlari icin geriye donuk secenekler. */
export function legacyWallets(): WalletOption[] {
  if (typeof window === "undefined" || !window.ethereum) return [];
  const providers = window.ethereum.providers?.length ? window.ethereum.providers : [window.ethereum];
  return providers.map((provider, index) => ({
    id: `${FALLBACK_WALLET_ID}-${index}`,
    name: legacyName(provider),
    rdns: null,
    provider,
  }));
}

/** EIP-6963 duyurusunu kullanicinin secebilecegi bir cuzdan secenegine cevirir. */
export function announcedWallet(event: Event): WalletOption | null {
  if (!(event instanceof CustomEvent) || !isEip6963Detail(event.detail)) return null;
  const { info, provider } = event.detail;
  return { id: info.uuid, name: info.name, rdns: info.rdns, provider };
}

/** EIP-6963 uyumlu eklentilerden yeniden duyuru ister. */
export function requestWalletAnnouncements(): void {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function hasWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectWallet(injected = window.ethereum): Promise<{
  provider: BrowserProvider;
  address: string;
  chainId: number;
}> {
  if (!injected) throw new Error("Bir Ethereum cuzdani bulunamadi.");
  const provider = new BrowserProvider(injected);
  const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
  if (!accounts[0]) throw new Error("Cuzdan hesap donmedi.");
  const net = await provider.getNetwork();
  return { provider, address: accounts[0], chainId: Number(net.chainId) };
}

/** Secilen cuzdanı Sepolia'ya gecirir; ag ekli degilse eklemeyi dener. */
export async function ensureSepolia(injected = window.ethereum): Promise<void> {
  if (!injected) throw new Error("Cuzdan yok.");
  try {
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (err: any) {
    if (err?.code === 4902) {
      await injected.request({
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
