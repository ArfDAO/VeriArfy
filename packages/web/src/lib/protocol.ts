import { Contract, formatUnits, type BrowserProvider, type Signer } from "ethers";

import { CONTRACTS } from "../config";
import {
  BIOMARKERS_ABI,
  ERC20_ABI,
  PAYMENTS_ABI,
  PROTOCOL_ABI,
  STORAGE_ABI,
} from "../config/abi";
import { encryptBiomarkers, encryptDosages, encryptGroup } from "./fhe";
import type { MetricPanel, MetricSpec } from "./metrics";

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

/**
 * Surekli olcum modulu — AYRI KONTRAT.
 *
 * Ayri olmasinin sebebi EIP-170'tir (protokol 24.576 baytlik kod sinirina
 * dayandi), ama pratikte onemli olan sonucu: girdi kaniti kontrat adresine
 * baglidir, yani olcumler BU adres icin sifrelenir.
 */
export function getBiomarkers(runner: BrowserProvider | Signer) {
  const address = CONTRACTS.VeriarfyBiomarkers;
  if (!address) throw new Error("Biyobelirtec modulu bu dagitimda yok.");
  return new Contract(address, BIOMARKERS_ABI, runner);
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

/** Filecoin kalicilik durumu — rapor §2.9.2. */
export interface PersistenceState {
  /** Kalicilik defteri dagitildi mi? */
  tracked: boolean;
  /** Su an kac FARKLI saglayicida duruyor. */
  replicas: number;
  /** WBS 2.3'teki 3 replika kurali saglaniyor mu? */
  adequate: boolean;
  /** Yenileme penceresine girildi mi? */
  dueForRenewal: boolean;
}

/**
 * Blob'un Filecoin'deki kalicilik durumunu okur.
 *
 * Defter dagitilmamissa ya da CID icin hic anlasma yoksa `tracked: false`
 * doner — panel bunu "IPFS'te pinli, Filecoin anlasmasi yok" olarak gosterir.
 * Uydurma bir "guvende" mesaji YOKTUR.
 */
export async function readPersistence(
  provider: BrowserProvider,
  cidDigest: string,
): Promise<PersistenceState> {
  const address = CONTRACTS.VeriarfyStorage;
  const empty: PersistenceState = {
    tracked: false,
    replicas: 0,
    adequate: false,
    dueForRenewal: false,
  };

  if (!address || !cidDigest || cidDigest === `0x${"0".repeat(64)}`) return empty;

  const storage = new Contract(address, STORAGE_ABI, provider);
  const dealCount = (await storage.dealCount(cidDigest)) as bigint;
  if (dealCount === 0n) return empty;

  const [replicas, adequate, dueForRenewal] = (await storage.persistenceStatus(
    cidDigest,
  )) as [bigint, boolean, boolean, bigint];

  return {
    tracked: true,
    replicas: Number(replicas),
    adequate,
    dueForRenewal,
  };
}

/** Nadirlik Carpani durumu — rapor §4.3. */
export interface RarityState {
  /** Katilimci esikli cozume izin verdi mi? */
  requested: boolean;
  /** KMS esigi biti cozdu ve zincir imzalari dogruladi mi? */
  confirmed: boolean;
  /** Sonuc: nadir varyant tasiyicisi mi? */
  isCarrier: boolean;
  /** Ilk 10.000 saglayicidan biri mi (kalici +%50)? */
  isFounding: boolean;
  /** Havuzun tamami — `R = log2(1 + N/C)` formulundeki N. */
  poolCount: number;
  /** Dogrulanmis tasiyici sayisi — formuldeki C. */
  carriers: number;
  /** Cozulecek sifreli bitin handle'i. */
  handle: string;
}

/**
 * Nadirlik carpani `R = log2(1 + N/C)` — baz puan cinsinden.
 *
 * Kontrattaki `RarityMath` ile AYNI degeri vermelidir; burada yalnizca
 * kullaniciya "su an ne kadar" gosterilir, odeme buna gore YAPILMAZ.
 * Odemede kullanilan deger her zaman zincirden (`queryWeights`) okunur.
 */
export function rarityMultiplierBps(poolCount: number, carriers: number): number {
  if (carriers <= 0 || poolCount <= 0) return 0;
  return Math.floor(Math.log2(1 + poolCount / carriers) * 10_000);
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

/** Nadirlik durumunu zincirden okur (rapor §4.3). */
export async function readRarity(
  provider: BrowserProvider,
  address: string,
): Promise<RarityState> {
  const protocol = getProtocol(provider);

  const [requested, isCarrier, confirmedAt, isFounding, stats, handle] = await Promise.all([
    protocol.rarityRequested(address) as Promise<boolean>,
    protocol.isRareCarrier(address) as Promise<boolean>,
    protocol.rarityConfirmedAtBlock(address) as Promise<bigint>,
    protocol.isFoundingContributor(address) as Promise<boolean>,
    protocol.rarityStats() as Promise<[bigint, bigint]>,
    protocol.rarityHandle(address) as Promise<string>,
  ]);

  return {
    requested,
    confirmed: confirmedAt > 0n,
    isCarrier,
    isFounding,
    poolCount: Number(stats[0]),
    carriers: Number(stats[1]),
    handle,
  };
}

/**
 * Nadirlik degerlendirmesini baslatir.
 *
 * Bu cagri BITI ACMAZ; yalnizca KMS dugumlerinin esikli cozumune izin verir.
 * Cozum ayri bir adimdir ve sonucu `confirmRarity` zincirde dogrular.
 */
export async function requestRarityAssessment(signer: Signer) {
  const tx = await getProtocol(signer).requestRarityAssessment();
  return tx.wait();
}

/**
 * Esikli cozulmus biti ve KMS imzalarini zincire yazar.
 *
 * @param decryptedResult Relayer'in dondurdugu `abiEncodedClearValues`.
 * @param decryptionProof Relayer'in dondurdugu `decryptionProof`.
 */
export async function confirmRarity(
  signer: Signer,
  participant: string,
  decryptedResult: string,
  decryptionProof: string,
) {
  const tx = await getProtocol(signer).confirmRarity(
    participant,
    decryptedResult,
    decryptionProof,
  );
  return tx.wait();
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

/* ------------------------------------------------------------------ *
 * Veri kategorisi 2 — surekli biyobelirtec kanali
 * ------------------------------------------------------------------ */

/**
 * Metrik panelini ZINCIRDEN okur.
 *
 * @remarks Panel yerel bir dosyadan degil zincirden okunur ve olmasi gereken
 *          budur: eleme sinirlarini sozlesme zorluyor. Yerel bir kopya
 *          kullanilsaydi, ilan edilen aralik ile ZORLANAN aralik sessizce
 *          ayrisabilirdi.
 */
export async function readMetricPanel(
  runner: BrowserProvider | Signer,
): Promise<MetricPanel & { metricsHash: string; metricsUri: string }> {
  const biomarkers = getBiomarkers(runner);
  const count = Number(await biomarkers.metricCount());

  const metrics: MetricSpec[] = [];
  for (let i = 0; i < count; i++) {
    const spec = await biomarkers.metricAt(i);
    metrics.push({
      code: decodeBytes32(spec.code),
      unit: decodeBytes32(spec.unit),
      scale: Number(spec.scale),
      offset: Number(spec.offset),
      minValue: Number(spec.minValue),
      maxValue: Number(spec.maxValue),
    });
  }

  return {
    panelId: "onchain",
    version: 1,
    metrics,
    metricsHash: await biomarkers.metricsHash(),
    metricsUri: await biomarkers.metricsUri(),
  };
}

/** `bytes32` icine sifir dolgulu ASCII etiketi geri okur. */
function decodeBytes32(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Kodlanmis olcumleri sifreleyip PARTILER halinde gonderir.
 *
 * @param values Panel sirasinda kodlanmis degerler (`alignToMetrics` ciktisi).
 * @param batchSize Parti buyuklugu; varsayilan olculen tavandir.
 *
 * @remarks Parti siniri fhEVM'in ISLEM BASINA HOMOMORFIK HESAP BUTCESIDIR
 *          (HCU, 20.000.000), blok gazi degil. Olcum basina kareyi alma
 *          islemi tek basina 596.000 HCU tuttugu icin tavan 8 metriktir
 *          (`packages/contracts/test/BiomarkerHcu.test.ts`).
 *
 *          Kontrat katkilarin SIRALI olmasini zorlar: her parti tam olarak
 *          `submittedMetrics` indeksinden baslar. Bu yuzden partiler
 *          birbirini beklemek zorundadir; paralel gonderim ikinci islemi
 *          revert ettirir.
 */
export async function contributeBiomarkers(
  signer: Signer,
  values: number[],
  options: {
    batchSize?: number;
    onBatch?: (outcome: TxOutcome, from: number, to: number) => void;
  } = {},
): Promise<TxOutcome[]> {
  const { batchSize = 6, onBatch } = options;

  const biomarkers = getBiomarkers(signer);
  const userAddress = await signer.getAddress();
  const contractAddress = await biomarkers.getAddress();

  const submitted = Number(await biomarkers.submittedMetrics(userAddress));
  const outcomes: TxOutcome[] = [];

  for (let i = submitted; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);

    const { handles, inputProof } = await encryptBiomarkers({
      contractAddress,
      userAddress,
      values: slice,
    });

    const tx = await biomarkers.contributeBiomarkers(handles, inputProof);
    const receipt = await tx.wait();

    const outcome: TxOutcome = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      handles,
    };
    outcomes.push(outcome);
    onBatch?.(outcome, i, i + slice.length);
  }

  return outcomes;
}

/* ------------------------------------------------------------------ *
 * Katki akisi — kayit, dozajlar, olcumler
 * ------------------------------------------------------------------ */

/** Grup etiketleri — kontrattaki `GROUP_*` sabitleriyle ayni. */
export const GROUP = { CONTROL: 0, CASE: 1 } as const;

/** Katilimcinin akistaki yeri; tamami ZINCIRDEN okunur. */
export interface ContributionState {
  isEnrolled: boolean;
  submittedSnps: number;
  snpCount: number;
  panelHash: string;
  biomarkerModule: string;
  submittedMetrics: number;
  metricCount: number;
  metricsHash: string;
  participantCount: number;
}

export async function readContributionState(
  runner: BrowserProvider | Signer,
  account: string,
): Promise<ContributionState> {
  const protocol = getProtocol(runner);

  const [isEnrolled, submittedSnps, snpCount, panelHash, biomarkerModule, participantCount] =
    await Promise.all([
      protocol.isEnrolled(account),
      protocol.submittedSnps(account),
      protocol.snpCount(),
      protocol.panelHash(),
      protocol.biomarkerModule(),
      protocol.participantCount(),
    ]);

  // Modul adresi ZINCIRDEN alinir, yapilandirmadan degil: sifreleme yanlis
  // adrese yapilirsa girdi kaniti reddedilir ve sebebi anlasilmaz.
  const biomarkers = new Contract(biomarkerModule, BIOMARKERS_ABI, runner);
  const [submittedMetrics, metricCount, metricsHash] = await Promise.all([
    biomarkers.submittedMetrics(account),
    biomarkers.metricCount(),
    biomarkers.metricsHash(),
  ]);

  return {
    isEnrolled,
    submittedSnps: Number(submittedSnps),
    snpCount: Number(snpCount),
    panelHash,
    biomarkerModule,
    submittedMetrics: Number(submittedMetrics),
    metricCount: Number(metricCount),
    metricsHash,
    participantCount: Number(participantCount),
  };
}

/** Bir islemin sonucu — konsolda kanit olarak gosterilir. */
export interface TxOutcome {
  hash: string;
  blockNumber: number;
  gasUsed: string;
  /** Bu islemde gonderilen sifreli degerlerin handle'lari. */
  handles: string[];
}

/**
 * Katilimciyi vaka/kontrol grubuna SIFRELI olarak kaydeder.
 *
 * @remarks Grup bir kez yazilir ve tum partilerde yeniden kullanilir. Her
 *          partide tekrar gonderilseydi katilimci partiler arasinda grup
 *          degistirip tabloyu bozabilirdi.
 */
export async function enroll(signer: Signer, group: number): Promise<TxOutcome> {
  const protocol = getProtocol(signer);
  const contractAddress = await protocol.getAddress();
  const userAddress = await signer.getAddress();

  const { handle, inputProof } = await encryptGroup({ contractAddress, userAddress, group });

  const tx = await protocol.enroll(handle, inputProof);
  const receipt = await tx.wait();

  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    handles: [handle],
  };
}

/**
 * Panele hizalanmis dozajlari PARTILER halinde sifreleyip gonderir.
 *
 * @param batchSize Olculen HCU tavani 12 SNP; varsayilan 10 pay birakir.
 *
 * @remarks Kontrat katkilarin SIRALI olmasini zorlar: her parti tam olarak
 *          `submittedSnps` indeksinden baslar. Bu yuzden partiler birbirini
 *          BEKLEMEK zorundadir; paralel gonderim ikinci islemi revert ettirir.
 *
 *          Zaten gonderilmis olan on ek atlanir — sayfa yenilendiginde ya da
 *          bir parti yarida kaldiginda kaldigi yerden devam eder.
 */
export async function contributeDosages(
  signer: Signer,
  dosages: number[],
  options: { batchSize?: number; onBatch?: (outcome: TxOutcome, from: number, to: number) => void } = {},
): Promise<TxOutcome[]> {
  const { batchSize = 10, onBatch } = options;

  const protocol = getProtocol(signer);
  const contractAddress = await protocol.getAddress();
  const userAddress = await signer.getAddress();

  const submitted = Number(await protocol.submittedSnps(userAddress));
  const outcomes: TxOutcome[] = [];

  for (let i = submitted; i < dosages.length; i += batchSize) {
    const slice = dosages.slice(i, i + batchSize);

    const { handles, inputProof } = await encryptDosages({
      contractAddress,
      userAddress,
      dosages: slice,
    });

    const tx = await protocol.contributeDosages(handles, inputProof);
    const receipt = await tx.wait();

    const outcome: TxOutcome = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      handles,
    };
    outcomes.push(outcome);
    onBatch?.(outcome, i, i + slice.length);
  }

  return outcomes;
}
