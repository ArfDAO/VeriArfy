import { Contract, formatUnits, type BrowserProvider, type Signer } from "ethers";

import { CONTRACTS } from "../config";
import { ERC20_ABI, PAYMENTS_ABI, PROTOCOL_ABI } from "../config/abi";

/**
 * Gizlilik Panelinin veri katmani.
 *
 * Buradaki her deger ZINCIRDEN okunur; hicbir yerde ornek/yer tutucu veri
 * uretilmez. Kontratlar deploy edilmemisse ya da cuzdan bagli degilse
 * fonksiyonlar hata firlatir — panel bunu kullaniciya acikca gosterir.
 */

export function getProtocol(runner: BrowserProvider | Signer) {
  return new Contract(CONTRACTS.VeriarfyProtocol, PROTOCOL_ABI, runner);
}

export function getPayments(runner: BrowserProvider | Signer) {
  return new Contract(CONTRACTS.VeriarfyPayments, PAYMENTS_ABI, runner);
}

export function getPaymentToken(runner: BrowserProvider | Signer) {
  return new Contract(CONTRACTS.PaymentToken, ERC20_ABI, runner);
}

/** Sorgu tipi bit maskesi — kontrattaki `QUERY_TYPE_*` sabitleriyle ayni. */
export const QUERY_TYPE = {
  GWAS: 1,
  ML: 2,
  STATISTICS: 4,
} as const;

export const QUERY_TYPE_LABELS: Record<number, string> = {
  1: "GWAS",
  2: "ML çıkarımı",
  4: "İstatistik",
};

/** Bit maskesini okunabilir etiketlere cevirir. */
export function describeQueryTypes(mask: number): string[] {
  return Object.entries(QUERY_TYPE_LABELS)
    .filter(([bit]) => (mask & Number(bit)) !== 0)
    .map(([, label]) => label);
}

export interface VaultRecord {
  /** IPFS CID digest'i (32 bayt, hex). Sifir ise henuz veri yuklenmemis. */
  cidDigest: string;
  /** Panelin Poseidon taahhudu. Panelin kendisi buradan cikarilamaz. */
  commitment: string;
  /** Havuza katilma sirasi; 0 ise sifreli dozaj henuz gonderilmemis. */
  participantIndex: number;
  hasAggregated: boolean;
}

export interface QuerySummary {
  id: number;
  researcher: string;
  fee: bigint;
  liquidityPot: bigint;
  snapshotCount: number;
  openedAtBlock: number;
  claimedTotal: bigint;
  /** Protokoldeki BSKK-44 acilim talebinin kimligi. */
  disclosureRequestId: number;
  /** Onay geldi ve ucret dagitima acildi mi? */
  settled: boolean;
  refunded: boolean;
  /** Bu cuzdanin bu sorgudan cekebilecegi tutar (0 = uygun degil). */
  claimable: bigint;
  claimed: boolean;
}

export interface PermissionRecord {
  researcher: string;
  isAllowed: boolean;
  queryTypes: number;
  grantedAtBlock: number;
  revokedAtBlock: bigint;
  expirationBlock: bigint;
  maxQueries: bigint;
}

export interface DashboardState {
  vault: VaultRecord;
  /** Havuzdaki toplam katilimci (protokol geneli). */
  poolParticipants: number;
  /** k-anonimlik esigi; altinda cozum talebi acilamaz. */
  minParticipants: number;
  pendingTotal: bigint;
  queries: QuerySummary[];
  permissions: PermissionRecord[];
  token: { symbol: string; decimals: number; balance: bigint };
}

/** Token tutarini okunabilir metne cevirir. */
export function formatToken(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

/**
 * Paneli tek seferde besleyen okuma.
 *
 * @param knownResearchers Izin durumu sorgulanacak adresler. Zincirde
 *        "bana kimler sordu" diye bir liste yok; bu yuzden adresler
 *        `AccessGranted` olaylarindan ve acilmis sorgulardan toplanir.
 */
export async function readDashboard(
  provider: BrowserProvider,
  address: string,
): Promise<DashboardState> {
  const protocol = getProtocol(provider);
  const payments = getPayments(provider);
  const token = getPaymentToken(provider);

  const [
    cidDigest,
    commitment,
    participantIndex,
    hasAggregated,
    poolParticipants,
    minParticipants,
    pending,
    nextQueryId,
    symbol,
    decimals,
    balance,
  ] = await Promise.all([
    protocol.userCIDs(address) as Promise<string>,
    protocol.panelCommitment(address) as Promise<bigint>,
    protocol.participantIndex(address) as Promise<bigint>,
    protocol.hasAggregated(address) as Promise<boolean>,
    protocol.participantCount() as Promise<bigint>,
    protocol.minParticipants() as Promise<bigint>,
    payments.pendingRewards(address) as Promise<[bigint, bigint[]]>,
    payments.nextQueryId() as Promise<bigint>,
    token.symbol() as Promise<string>,
    token.decimals() as Promise<bigint>,
    token.balanceOf(address) as Promise<bigint>,
  ]);

  // Sorgular: en yeniden eskiye, en fazla 25 tanesi. Zincirde sayfalama yok;
  // panelin acilisini yavaslatmamak icin sinirli okunur.
  const total = Number(nextQueryId);
  const first = Math.max(0, total - 25);
  const ids = Array.from({ length: total - first }, (_, i) => first + i).reverse();

  const queries: QuerySummary[] = await Promise.all(
    ids.map(async (id) => {
      const [q, amount, claimed] = await Promise.all([
        payments.query(id) as Promise<any>,
        payments.claimable(id, address) as Promise<bigint>,
        payments.hasClaimed(id, address) as Promise<boolean>,
      ]);
      return {
        id,
        researcher: q.researcher as string,
        fee: q.fee as bigint,
        liquidityPot: q.liquidityPot as bigint,
        snapshotCount: Number(q.snapshotCount),
        openedAtBlock: Number(q.openedAtBlock),
        claimedTotal: q.claimedTotal as bigint,
        disclosureRequestId: Number(q.disclosureRequestId),
        settled: q.settled as boolean,
        refunded: q.refunded as boolean,
        claimable: amount,
        claimed,
      };
    }),
  );

  // Izin durumu: sorgularda gorulen arastirmacilar + gecmiste izin verilenler.
  const researchers = new Set(queries.map((q) => q.researcher.toLowerCase()));
  try {
    const granted = await protocol.queryFilter(
      protocol.filters.AccessGranted(address),
      -50_000,
    );
    for (const log of granted) {
      const target = (log as any).args?.researcher as string | undefined;
      if (target) researchers.add(target.toLowerCase());
    }
  } catch {
    // Bazi RPC saglayicilari genis blok araligi icin log sorgusunu reddeder.
    // Izin listesi eksik kalir ama panelin geri kalani calisir.
  }

  const permissions: PermissionRecord[] = await Promise.all(
    [...researchers].map(async (researcher) => {
      const p = await protocol.permission(address, researcher);
      return {
        researcher,
        isAllowed: p.isAllowed as boolean,
        queryTypes: Number(p.queryTypes),
        grantedAtBlock: Number(p.grantedAtBlock),
        revokedAtBlock: p.revokedAtBlock as bigint,
        expirationBlock: p.expirationBlock as bigint,
        maxQueries: p.maxQueries as bigint,
      };
    }),
  );

  return {
    vault: {
      cidDigest,
      commitment: commitment.toString(),
      participantIndex: Number(participantIndex),
      hasAggregated,
    },
    poolParticipants: Number(poolParticipants),
    minParticipants: Number(minParticipants),
    pendingTotal: pending[0],
    queries,
    permissions: permissions.filter((p) => p.grantedAtBlock > 0),
    token: { symbol, decimals: Number(decimals), balance },
  };
}

/** Bir arastirmaciya izin verir. `expirationBlock = 0` -> suresiz. */
export async function grantAccess(
  signer: Signer,
  researcher: string,
  queryTypes: number,
  expirationBlock = 0n,
  maxQueries = 0n,
) {
  const tx = await getProtocol(signer).grantAccess(
    researcher,
    queryTypes,
    expirationBlock,
    maxQueries,
  );
  return tx.wait();
}

/** Verilen izni geri alir (rapor §3.4.1). */
export async function revokeAccess(signer: Signer, researcher: string) {
  const tx = await getProtocol(signer).revokeAccess(researcher);
  return tx.wait();
}

/** Bir sorgudan hak edilen payi ceker. */
export async function claimReward(signer: Signer, queryId: number) {
  const tx = await getPayments(signer).claim(queryId);
  return tx.wait();
}
