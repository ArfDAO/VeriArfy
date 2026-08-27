import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { BrowserProvider, type Signer } from "ethers";

import { SEPOLIA_CHAIN_ID } from "../config";
import { readResearcherReadiness } from "./protocol";
import {
  announcedWallet,
  connectWallet,
  ensureSepolia,
  legacyWallets,
  requestWalletAnnouncements,
  type WalletOption,
} from "./wallet";

export type SessionRole = "veri-sahibi" | "arastirmaci" | null;

interface SessionState {
  provider: BrowserProvider | null;
  signer: Signer | null;
  address: string | null;
  chainId: number | null;
  role: SessionRole;
  wallets: WalletOption[];
  activeWallet: WalletOption | null;
  walletAvailable: boolean;
  restoring: boolean;
  researcherRegistered: boolean | null;
  error: string | null;
  connect: (walletId?: string) => Promise<void>;
  switchToSepolia: () => Promise<void>;
  selectRole: (role: Exclude<SessionRole, null>) => void;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const ROLE_STORAGE_KEY = "veriarfy.session.role";
const WALLET_RDNS_STORAGE_KEY = "veriarfy.session.wallet-rdns";
const SessionContext = createContext<SessionState | null>(null);

function readStoredRole(): SessionRole {
  const value = window.localStorage.getItem(ROLE_STORAGE_KEY);
  return value === "veri-sahibi" || value === "arastirmaci" ? value : null;
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as { shortMessage?: string; message?: string };
    return candidate.shortMessage ?? candidate.message ?? fallback;
  }
  return fallback;
}

function mergeWallets(current: WalletOption[], next: WalletOption): WalletOption[] {
  const duplicate = current.some(
    (wallet) => wallet.id === next.id || wallet.provider === next.provider,
  );
  return duplicate ? current : [...current, next];
}

export function SessionProvider({ children }: PropsWithChildren) {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [role, setRole] = useState<SessionRole>(() => readStoredRole());
  const [wallets, setWallets] = useState<WalletOption[]>(() => legacyWallets());
  const [activeWallet, setActiveWallet] = useState<WalletOption | null>(null);
  const [preferredRdns, setPreferredRdns] = useState<string | null>(
    () => window.localStorage.getItem(WALLET_RDNS_STORAGE_KEY),
  );
  const [restoring, setRestoring] = useState(true);
  const [researcherRegistered, setResearcherRegistered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // EIP-6963, provider duyurularinin sayfa omru boyunca dinlenmesini ister.
  useEffect(() => {
    const handleAnnouncement = (event: Event) => {
      const wallet = announcedWallet(event);
      if (wallet) setWallets((current) => mergeWallets(current, wallet));
    };

    window.addEventListener("eip6963:announceProvider", handleAnnouncement);
    for (const wallet of legacyWallets()) {
      setWallets((current) => mergeWallets(current, wallet));
    }
    requestWalletAnnouncements();

    return () => window.removeEventListener("eip6963:announceProvider", handleAnnouncement);
  }, []);

  const clearAccount = useCallback(() => {
    setProvider(null);
    setSigner(null);
    setAddress(null);
    setChainId(null);
    setResearcherRegistered(null);
  }, []);

  const updateResearcherRegistration = useCallback(
    async (nextProvider: BrowserProvider, nextAddress: string, nextChainId: number) => {
      if (nextChainId !== SEPOLIA_CHAIN_ID) {
        setResearcherRegistered(null);
        return;
      }
      try {
        const readiness = await readResearcherReadiness(nextProvider, nextAddress);
        setResearcherRegistered(readiness.registered);
      } catch {
        // Registry okunamadiginda "kayitli" varsayimi yapmak yetki acigi olur.
        setResearcherRegistered(null);
      }
    },
    [],
  );

  const chooseWallet = useCallback(
    (walletId?: string): WalletOption | null => {
      if (walletId) return wallets.find((wallet) => wallet.id === walletId) ?? null;
      if (activeWallet) return activeWallet;
      if (preferredRdns) {
        const preferred = wallets.find((wallet) => wallet.rdns === preferredRdns);
        if (preferred) return preferred;
      }
      return wallets[0] ?? null;
    },
    [activeWallet, preferredRdns, wallets],
  );

  const hydrate = useCallback(
    async (requestAccess: boolean, walletId?: string) => {
      const wallet = chooseWallet(walletId);
      if (!wallet) {
        clearAccount();
        return;
      }

      try {
        const result = requestAccess
          ? await connectWallet(wallet.provider)
          : await (async () => {
              const nextProvider = new BrowserProvider(wallet.provider);
              const accounts = (await nextProvider.send("eth_accounts", [])) as string[];
              if (!accounts[0]) return null;
              const network = await nextProvider.getNetwork();
              return {
                provider: nextProvider,
                address: accounts[0],
                chainId: Number(network.chainId),
              };
            })();

        if (!result) {
          clearAccount();
          return;
        }

        const nextSigner = await result.provider.getSigner(result.address);
        setActiveWallet(wallet);
        if (wallet.rdns) {
          window.localStorage.setItem(WALLET_RDNS_STORAGE_KEY, wallet.rdns);
          setPreferredRdns(wallet.rdns);
        }
        setProvider(result.provider);
        setSigner(nextSigner);
        setAddress(result.address);
        setChainId(result.chainId);
        setError(null);
        await updateResearcherRegistration(result.provider, result.address, result.chainId);
      } catch (nextError) {
        clearAccount();
        if (requestAccess) setError(messageOf(nextError, "Cuzdan baglanamadi."));
      }
    },
    [chooseWallet, clearAccount, updateResearcherRegistration],
  );

  const refresh = useCallback(async () => {
    await hydrate(false);
  }, [hydrate]);

  useEffect(() => {
    void hydrate(false).finally(() => setRestoring(false));
  }, [hydrate]);

  useEffect(() => {
    if (!activeWallet?.provider.on) return;
    const onAccountsChanged = () => void refresh();
    const onChainChanged = () => void refresh();
    activeWallet.provider.on("accountsChanged", onAccountsChanged);
    activeWallet.provider.on("chainChanged", onChainChanged);

    return () => {
      activeWallet.provider.removeListener?.("accountsChanged", onAccountsChanged);
      activeWallet.provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [activeWallet, refresh]);

  const connect = useCallback(
    async (walletId?: string) => {
      setError(null);
      await hydrate(true, walletId);
    },
    [hydrate],
  );

  const switchToSepolia = useCallback(async () => {
    if (!activeWallet) {
      setError("Once bir cuzdan secin.");
      return;
    }
    try {
      await ensureSepolia(activeWallet.provider);
      await refresh();
    } catch (nextError) {
      setError(messageOf(nextError, "Sepolia'ya gecilemedi."));
    }
  }, [activeWallet, refresh]);

  const selectRole = useCallback((nextRole: Exclude<SessionRole, null>) => {
    window.localStorage.setItem(ROLE_STORAGE_KEY, nextRole);
    setRole(nextRole);
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(ROLE_STORAGE_KEY);
    setRole(null);
    setError(null);
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      provider,
      signer,
      address,
      chainId,
      role,
      wallets,
      activeWallet,
      walletAvailable: wallets.length > 0,
      restoring,
      researcherRegistered,
      error,
      connect,
      switchToSepolia,
      selectRole,
      signOut,
      refresh,
    }),
    [
      activeWallet,
      address,
      chainId,
      connect,
      error,
      provider,
      refresh,
      researcherRegistered,
      restoring,
      role,
      signer,
      signOut,
      switchToSepolia,
      wallets,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession, SessionProvider icinde kullanilmalidir.");
  return context;
}
