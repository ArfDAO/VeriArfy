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
import { connectWallet, ensureSepolia, hasWallet } from "./wallet";

export type SessionRole = "veri-sahibi" | "arastirmaci" | null;

interface SessionState {
  provider: BrowserProvider | null;
  signer: Signer | null;
  address: string | null;
  chainId: number | null;
  role: SessionRole;
  walletAvailable: boolean;
  restoring: boolean;
  researcherRegistered: boolean | null;
  error: string | null;
  connect: () => Promise<void>;
  switchToSepolia: () => Promise<void>;
  selectRole: (role: Exclude<SessionRole, null>) => void;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const ROLE_STORAGE_KEY = "veriarfy.session.role";
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

export function SessionProvider({ children }: PropsWithChildren) {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [role, setRole] = useState<SessionRole>(() => readStoredRole());
  const [walletAvailable, setWalletAvailable] = useState(() => hasWallet());
  const [restoring, setRestoring] = useState(true);
  const [researcherRegistered, setResearcherRegistered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const hydrate = useCallback(async (requestAccess: boolean) => {
    setWalletAvailable(hasWallet());
    if (!hasWallet()) {
      clearAccount();
      return;
    }

    try {
      const result = requestAccess
        ? await connectWallet()
        : await (async () => {
            const nextProvider = new BrowserProvider(window.ethereum!);
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
  }, [clearAccount, updateResearcherRegistration]);

  const refresh = useCallback(async () => {
    await hydrate(false);
  }, [hydrate]);

  useEffect(() => {
    void hydrate(false).finally(() => setRestoring(false));
  }, [hydrate]);

  useEffect(() => {
    if (!window.ethereum?.on) return;

    const onAccountsChanged = () => void refresh();
    const onChainChanged = () => void refresh();
    window.ethereum.on("accountsChanged", onAccountsChanged);
    window.ethereum.on("chainChanged", onChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    setError(null);
    await hydrate(true);
  }, [hydrate]);

  const switchToSepolia = useCallback(async () => {
    try {
      await ensureSepolia();
      await refresh();
    } catch (nextError) {
      setError(messageOf(nextError, "Sepolia'ya gecilemedi."));
    }
  }, [refresh]);

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
      walletAvailable,
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
      walletAvailable,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession, SessionProvider icinde kullanilmalidir.");
  return context;
}
