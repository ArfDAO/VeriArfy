import { Contract, formatUnits, type BrowserProvider, type Signer } from "ethers";

import { CONTRACTS, ZERO_ADDRESS } from "../config";
import {
  BIOMARKERS_ABI,
  ERC20_ABI,
  PAYMENTS_ABI,
  PROTOCOL_ABI,
  REGISTRY_ABI,
  STAKING_ABI,
  STORAGE_ABI,
} from "../config/abi";
import { encryptBiomarkers, encryptDosages, encryptGroup } from "./fhe";
import { DOSAGE_MISSING } from "./panel";
import { handlesDigest, proveSelfProvenance, randomSalt } from "./provenance";
import { BIOMARKER_MISSING } from "./metrics";
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

/** Sorgunun BSKK-44 akisindaki asamasi. */
export type QueryStage =
  | "onay-bekliyor"
  | "itiraz-suresi"
  | "yurutme-bekliyor"
  | "iptal"
  | "paylasim-bekliyor"
  | "paylasildi"
  | "iade";

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
  /**
   * Acilim talebinin GERCEK asamasi.
   *
   * @remarks Yalnizca `settled` bakmak dort ayri durumu tek etikete
   *          sikistiriyordu: onay bekleyen bir sorgu ile onaylanip itiraz
   *          suresinde bekleyen sorgu ayni gorunuyordu. Katilimci acisindan
   *          bunlar cok farkli seyler — biri hala reddedilebilir, digeri
   *          fiilen kesinlesmis.
   */
  stage: QueryStage;
  /** Onay geldi ve ucret dagitima acildi mi? */
  settled: boolean;
  refunded: boolean;
  /** Bu cuzdanin bu sorgudan cekebilecegi tutar (0 = uygun degil). */
  claimable: bigint;
  /** Bu sorguda KAC ALANA veri verdiniz — kullanim payinin dayanagi. */
  coverageWeight: number;
  /**
   * Kitlikla agirliklandirilmis pay (baz puan toplami).
   *
   * Kullanim odemesinin gercek payi budur; `coverageWeight` yalnizca kac
   * alan verildigini soyler. Nadir bir alan burada daha buyuk gorunur.
   */
  weightedCoverage: number;
  /** Agirliklarin sorgu genelindeki toplami — payda. */
  weightedTotal: number;
  /** Sorgunun ham kayit toplami (kac kisi x kac alan) — gosterim icin. */
  coverageTotal: number;
  claimed: boolean;
}

/**
 * Katilimcinin havuzdaki durumu.
 *
 * @remarks IZIN KAPISI KALKTI. Arastirmaci bazinda izin, mimarinin
 *          tutamayacagi bir sozdu: acilim TOPLAMI donduruyor ve toplam
 *          globaldir — "su kuruma evet, buna hayir" demek mumkun degildi.
 *          Yukleme zaten izindir; geriye "havuzdan cikma" hakki kaldi.
 */
export interface PoolMembership {
  /** Havuzdan cikildiysa cikis blogu; 0 ise hala icerde. */
  leftAtBlock: number;
  /** Su an havuzda mi? */
  active: boolean;
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
  membership: PoolMembership;
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

  // Itiraz suresinin dolup dolmadigi BLOK NUMARASINA baglidir; bir kez
  // okunur ve tum sorgular icin ayni ana gore degerlendirilir.
  const blockNumber = await provider.getBlockNumber();

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
      const [q, amount, claimed, coverage, weighted, weightedAll] = await Promise.all([
        payments.query(id) as Promise<any>,
        payments.claimable(id, address) as Promise<bigint>,
        payments.hasClaimed(id, address) as Promise<boolean>,
        payments.coverageWeight(id, address) as Promise<bigint>,
        // Kitlikla agirliklandirilmis pay — kullanim odemesinin GERCEK payi.
        // Ham alan sayisi yalnizca "kac alan"; bu "o alanlar ne kadar nadir".
        payments.weightedCoverage(id, address) as Promise<bigint>,
        payments.weightedTotal(id) as Promise<bigint>,
      ]);

      const requestId = Number(q.disclosureRequestId);
      let stage: QueryStage;

      if (q.refunded) {
        stage = "iade";
      } else if (q.settled) {
        stage = "paylasildi";
      } else {
        // Odeme sozlesmesi acilimin nerede oldugunu BILMEZ; onu protokole
        // sormak gerekir. Sormadan "onay bekliyor" demek, onaylanmis bir
        // sorguyu onaylanmamis gibi gostermek olurdu.
        const [finalized, revoked] = await Promise.all([
          protocol.isDisclosureFinalized(requestId) as Promise<boolean>,
          protocol.isDisclosureRevoked(requestId) as Promise<boolean>,
        ]);

        if (revoked) {
          stage = "iptal";
        } else if (!finalized) {
          stage = "onay-bekliyor";
        } else {
          const endsAt = Number(await protocol.challengeWindowEnd(requestId));
          stage = blockNumber < endsAt ? "itiraz-suresi" : "yurutme-bekliyor";
        }
      }

      return {
        stage,
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
        coverageWeight: Number(coverage),
        coverageTotal: Number(q.coverageTotal),
        weightedCoverage: Number(weighted),
        weightedTotal: Number(weightedAll),
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

  const leftAtBlock = Number(await protocol.leftPoolAtBlock(address));

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
    membership: {
      leftAtBlock,
      active: Number(participantIndex) > 0 && leftAtBlock === 0,
    },
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

/**
 * HAVUZDAN CIK — bundan sonraki calismalarda verim kullanilmasin.
 *
 * @remarks Cikis GECMISI SILMEZ: toplama karisan geri cikarilamaz. Bu bir
 *          uygulama eksigi degil, homomorfik toplamanin dogasidir. Cikmadan
 *          ONCE acilan sorgulardan hak edilen paylar da korunur — cikmak
 *          cezalandirma degildir.
 */
export async function leavePool(signer: Signer) {
  const tx = await getProtocol(signer).leavePool();
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

    // Kapsama maskesi olcumlerden TURETILIR — kullaniciya sorulmaz.
    // Bos birakilan metrik `BIOMARKER_MISSING` (0) gider ve kapsanmaz.
    let coverageMask = 0n;
    for (let j = 0; j < slice.length; j++) {
      if (slice[j] !== BIOMARKER_MISSING) coverageMask |= 1n << BigInt(j);
    }

    const tx = await biomarkers.contributeBiomarkers(handles, coverageMask, inputProof);
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
  options: {
    batchSize?: number;
    onBatch?: (outcome: TxOutcome, from: number, to: number) => void;
    /** Sifreleme bitince, ILK islem gitmeden once cagrilir. */
    onEncrypted?: (handles: string[]) => Promise<void> | void;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<TxOutcome[]> {
  const { batchSize = 10, onBatch, onEncrypted, onProgress } = options;

  const protocol = getProtocol(signer);
  const contractAddress = await protocol.getAddress();
  const userAddress = await signer.getAddress();

  const submitted = Number(await protocol.submittedSnps(userAddress));

  // ---------------------------------------------------------------------
  // 1. asama — HEPSINI once sifrele
  // ---------------------------------------------------------------------
  //
  // NEDEN AYRI ASAMA: koken kaniti, havuza girecek sifreli metinlerin
  // ozetine baglanir ve kanit dozajlardan ONCE gitmelidir. Sozlesme, kaydi
  // olan bir katilimcinin beyan ettigi kapsamanin kanitin ALT KUMESI
  // olmasini sart kosar (`CoverageNotProven`); yani sira tersine donerse
  // kanit yolu bos yere kurulmus olur.
  //
  // Sifreleme Zama relayer'ina gider ve saniyeler surer; yine de islemler
  // baslamadan once tamamlanmasi gerekir.
  const batches: { from: number; slice: number[]; handles: string[]; inputProof: string }[] = [];

  for (let i = submitted; i < dosages.length; i += batchSize) {
    const slice = dosages.slice(i, i + batchSize);
    const { handles, inputProof } = await encryptDosages({
      contractAddress,
      userAddress,
      dosages: slice,
    });
    batches.push({ from: i, slice, handles, inputProof });
    onProgress?.(i + slice.length - submitted, dosages.length - submitted);
  }

  if (batches.length > 0) {
    await onEncrypted?.(batches.flatMap((b) => b.handles));
  }

  // ---------------------------------------------------------------------
  // 2. asama — sirayla gonder
  // ---------------------------------------------------------------------
  //
  // Kontrat katkilarin SIRALI olmasini zorlar: her parti tam olarak
  // `submittedSnps` indeksinden baslar. Paralel gonderim ikinci islemi
  // revert ettirir.
  const outcomes: TxOutcome[] = [];

  for (const batch of batches) {
    // KAPSAMA MASKESI — kullaniciya SORULMAZ, veriden turetilir.
    //
    // Siradan bir kullanici dosyasinin icinde hangi varyantlarin oldugunu
    // bilmez; dosyanin TURUNU bilir. Hangi alanda gercek veri oldugunu
    // ayristirici belirler ve o bilgi zaten burada: hizalanmis dizide
    // `DOSAGE_MISSING` olmayan her alan gercek veridir.
    //
    // Kaydi olan katilimci icin bu maske artik kapsamayi YAZMAZ; kanitla
    // yazilani DOGRULAR. Uyusmazlik zincirde `CoverageNotProven` ile duser.
    let coverageMask = 0n;
    for (let j = 0; j < batch.slice.length; j++) {
      if (batch.slice[j] !== DOSAGE_MISSING) coverageMask |= 1n << BigInt(j);
    }

    const tx = await protocol.contributeDosages(batch.handles, coverageMask, batch.inputProof);
    const receipt = await tx.wait();

    const outcome: TxOutcome = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      handles: batch.handles,
    };
    outcomes.push(outcome);
    onBatch?.(outcome, batch.from, batch.from + batch.slice.length);
  }

  return outcomes;
}

/**
 * ZK koken kaydini gonderir — KENDI YUKLEDIGIM katmani (`attested = false`).
 *
 * @param dosages Panele hizalanmis dozajlar (kanit icinde kalir, zincire GIRMEZ).
 * @param handles Havuza girecek sifreli metinler; kanit bunlarin ozetine baglanir.
 *
 * @remarks Kaydi zaten olan katilimci icin sessizce atlanir: `submitRecord`
 *          kaydin uzerine yazabilir ama nullifier yalnizca bir kez
 *          harcanabilir, yeni bir salt ile yeni bir kanit gerekir. Sayfa
 *          yenilendiginde bos yere kanit uretmemek icin once bakilir.
 */
export async function submitProvenanceRecord(
  signer: Signer,
  dosages: number[],
  handles: string[],
  options: { onStage?: (stage: "digest" | "proving" | "sending") => void } = {},
): Promise<{ outcome: TxOutcome; digest: string; provingMs: number; coveredFields: number } | null> {
  const protocol = getProtocol(signer);
  const userAddress = await signer.getAddress();

  if ((await protocol.panelCommitment(userAddress)) !== 0n) return null;

  options.onStage?.("digest");
  const digest = await handlesDigest(handles);

  options.onStage?.("proving");
  const scope = await protocol.PROVENANCE_SCOPE();
  const proof = await proveSelfProvenance({
    dosages,
    salt: randomSalt(),
    externalNullifier: scope,
    blobDigest: digest,
    signerAddress: userAddress,
  });

  options.onStage?.("sending");
  const tx = await protocol.submitRecord(
    digest,
    false, // imzasiz katman — akredite kurum entegrasyonu yok
    0n, // devre koku zorla sifirlar; sozlesme de sifir bekler
    proof.nullifierHash,
    proof.commitment,
    proof.coverage,
    proof.a,
    proof.b,
    proof.c,
  );
  const receipt = await tx.wait();

  return {
    outcome: {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      handles: [],
    },
    digest,
    provingMs: proof.provingMs,
    coveredFields: dosages.filter((d) => d !== DOSAGE_MISSING).length,
  };
}

/* ------------------------------------------------------------------ *
 * Arastirmaci akisi — odeme, esikli onay, cozum, istatistik
 * ------------------------------------------------------------------ */

/** Bir acilim talebinin ZINCIRDEN okunan hali. */
export interface DisclosureState {
  requestId: number;
  requester: string;
  snapshotCount: number;
  approvals: number;
  requiredApprovals: number;
  finalized: boolean;
  revoked: boolean;
  /** Itiraz suresinin bittigi blok; 0 = henuz esige ulasilmadi. */
  challengeEndsAtBlock: number;
  currentBlock: number;
  /**
   * Cozum yetkisi GERCEKTEN verildi mi? (`FHE.allow` yazildi mi)
   *
   * @remarks Bu, "itiraz suresi doldu" ile AYNI SEY DEGILDIR. Sure dolmus
   *          ama `executeDisclosure` hic cagrilmamis olabilir — o zaman ACL
   *          izni yoktur ve cozum `not authorized to user decrypt handle`
   *          ile duser.
   */
  executed: boolean;
  /** Sure doldu, iptal yok, henuz yurutulmedi — `executeDisclosure` cagrilabilir. */
  canExecute: boolean;
  /** Talepte SECILEN SNP'ler — aralik degil, liste. */
  snpIds: number[];
  /** Talepte secilen metrikler. */
  metricIds: number[];
}

export async function readDisclosure(
  runner: BrowserProvider | Signer,
  requestId: number,
  queryType: number,
): Promise<DisclosureState> {
  const protocol = getProtocol(runner);
  const provider = "provider" in runner ? (runner as any).provider : runner;

  const [info, finalized, revoked, granted, required, snpIds, metricIds, currentBlock] =
    await Promise.all([
      protocol.disclosureRequest(requestId),
      protocol.isDisclosureFinalized(requestId),
      protocol.isDisclosureRevoked(requestId),
      protocol.isDisclosureGranted(requestId),
      protocol.requiredApprovals(queryType),
      protocol.disclosureSnpIds(requestId),
      protocol.disclosureMetricIds(requestId),
      provider.getBlockNumber(),
    ]);

  const challengeEndsAtBlock = finalized
    ? Number(await protocol.challengeWindowEnd(requestId))
    : 0;

  // YURUTULDU MU — zincirden OKUNUR, cikarilmaz.
  //
  // Onceki surum bunu "esige ulasildi + sure doldu" diye TAHMIN ediyordu ve
  // bu yanlisti: sure dolmus olabilir ama `executeDisclosure` hic cagrilmamis
  // olabilir. O halde ACL izni yoktur ve cozum
  // `not authorized to user decrypt handle` ile duser — tam olarak yasandi.
  //
  // `isDisclosureGranted` dogrudan `request.executed` bayragini dondurur.
  const executed: boolean = granted;

  const canExecute =
    finalized &&
    !revoked &&
    !executed &&
    challengeEndsAtBlock > 0 &&
    currentBlock >= challengeEndsAtBlock;

  return {
    requestId,
    requester: info.requester,
    snapshotCount: Number(info.snapshotCount),
    approvals: Number(info.approvals),
    requiredApprovals: Number(required),
    finalized,
    revoked,
    challengeEndsAtBlock,
    currentBlock,
    executed,
    canExecute,
    snpIds: (snpIds as bigint[]).map(Number),
    metricIds: (metricIds as bigint[]).map(Number),
  };
}

/**
 * Sorgu acar: ucreti oder ve acilim talebini baslatir.
 *
 * @remarks Odeme sozlesmesi protokolun "sorgu kapisi"dir; talebi dogrudan
 *          arastirmaci acamaz. Boylece kayit ve ucret kontrolu tek yerde
 *          kalir ve protokolun arastirmaci defterini tanimasina gerek olmaz.
 *
 *          Ucret EMANETTE tutulur; onay gelmezse iade edilir.
 */
export async function openQuery(
  signer: Signer,
  queryType: number,
  fields?: { snpIds: number[]; metricIds: number[] },
): Promise<{ tx: TxOutcome; queryId: number; fee: bigint }> {
  const payments = getPayments(signer);
  const token = getPaymentToken(signer);
  const who = await signer.getAddress();
  const paymentsAddress = await payments.getAddress();

  // Fiyat ISTENEN ALANLARA gore hesaplanir. Alan secilmediyse varsayilan
  // pencerenin fiyati alinir — sozlesme de ayni listeyi kullanir.
  const [fee] = fields
    ? await payments.quoteForFields(fields.snpIds, fields.metricIds)
    : await payments.quote();

  // Harcama izni yetersizse once onu ver — aksi halde `openQuery` anlasilmaz
  // bir ERC-20 hatasiyla duser.
  const allowance: bigint = await token.allowance(who, paymentsAddress);
  if (allowance < fee) {
    await (await token.approve(paymentsAddress, fee)).wait();
  }

  const queryId = Number(await payments.nextQueryId());

  // Alan secildiyse tam olarak o alanlar acilir; secilmediyse protokolun
  // varsayilani (tavana kadar tum alanlar) kullanilir.
  const tx = fields
    ? await payments.openQueryFields(queryType, fields.snpIds, fields.metricIds)
    : await payments.openQuery(queryType);
  const receipt = await tx.wait();

  return {
    tx: {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      handles: [],
    },
    queryId,
    fee,
  };
}

/** Yetkili dugum onayi (BSKK-44 esigi). */
export async function approveDisclosure(
  signer: Signer,
  requestId: number,
): Promise<TxOutcome> {
  const protocol = getProtocol(signer);
  const tx = await protocol.approveDisclosure(requestId);
  const receipt = await tx.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    handles: [],
  };
}

/** Itiraz suresi dolduktan sonra cozum yetkisini verir. */
export async function executeDisclosure(
  signer: Signer,
  requestId: number,
): Promise<TxOutcome> {
  const protocol = getProtocol(signer);
  const tx = await protocol.executeDisclosure(requestId);
  const receipt = await tx.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    handles: [],
  };
}

/** Ucreti bolustuurur: %80 katilimcilara, %20 hazineye. */
export async function settleQuery(signer: Signer, queryId: number): Promise<TxOutcome> {
  const payments = getPayments(signer);
  const tx = await payments.settleQuery(queryId);
  const receipt = await tx.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    handles: [],
  };
}

/**
 * Cozulecek bir handle, ait oldugu kontrat ve BIT GENISLIGI.
 *
 * @remarks `bits` cagirandan tasiniyor cunku relayer tek istekte en fazla
 *          2048 sifreli bit cozuyor ve parcalama buna gore yapiliyor.
 *          Handle'dan tip cikarmak yerine bilinen tipi tasimak daha az
 *          kirilgan: handle bicimi degisirse cikarim sessizce yanlislanirdi.
 */
export interface HandlePair {
  handle: string;
  contractAddress: string;
  bits: number;
}

/**
 * Acilim penceresindeki TUM sifreli handle'lari toplar.
 *
 * @remarks Kontenjans tablosu protokolde, biyobelirtec toplamlari MODULDE
 *          durur. ACL kaydi handle+kontrat ikilisine bagli oldugu icin her
 *          handle'in hangi kontrattan geldigi tasinmak zorundadir.
 */
export async function collectDisclosureHandles(
  runner: BrowserProvider | Signer,
  state: DisclosureState,
): Promise<{
  contingency: { snp: number; cells: string[][] }[];
  biomarkers: { metric: number; group: number; sum: string; sumSq: string; count: string }[];
  pairs: HandlePair[];
}> {
  const protocol = getProtocol(runner);
  const protocolAddress = await protocol.getAddress();
  const biomarkerModule: string = await protocol.biomarkerModule();

  const pairs: HandlePair[] = [];

  const contingency: { snp: number; cells: string[][] }[] = [];
  for (const snp of state.snpIds) {
    const table = await protocol.disclosureContingencyAt(state.requestId, snp);
    const cells = (table as string[][]).map((row) => [...row]);
    contingency.push({ snp, cells });
    for (const row of cells) {
      // Kontenjans hucreleri `euint32`.
      for (const handle of row) {
        pairs.push({ handle, contractAddress: protocolAddress, bits: 32 });
      }
    }
  }

  const biomarkers: {
    metric: number;
    group: number;
    sum: string;
    sumSq: string;
    count: string;
  }[] = [];

  if (biomarkerModule && state.metricIds.length > 0) {
    const module = new Contract(biomarkerModule, BIOMARKERS_ABI, runner);
    for (const metric of state.metricIds) {
      for (let group = 0; group < 2; group++) {
        const [sum, sumSq, count] = await module.disclosureBiomarkerAt(
          state.requestId,
          metric,
          group,
        );
        biomarkers.push({ metric, group, sum, sumSq, count });
        // Toplam ve kareler toplami `euint64`, sayim `euint32`.
        pairs.push({ handle: sum, contractAddress: biomarkerModule, bits: 64 });
        pairs.push({ handle: sumSq, contractAddress: biomarkerModule, bits: 64 });
        pairs.push({ handle: count, contractAddress: biomarkerModule, bits: 32 });
      }
    }
  }

  return { contingency, biomarkers, pairs };
}

/**
 * `openQuery` ON KOSULLARI — hepsi zincirden okunur.
 *
 * @remarks Sozlesme uc sarti da revert ile zorluyor. Onceden okunmasalardi
 *          kullanici sebebi anlasilmayan bir islem hatasi gorurdu; hangi
 *          sartin tutmadigi ancak revert verisini cozerek anlasilirdi.
 */
export interface ResearcherReadiness {
  /** ZK kimlik kaniti ile arastirmaci defterine kayitli mi? */
  registered: boolean;
  /** Havuzdaki katilimci sayisi. 0 ise sorgu acilamaz. */
  participants: number;
  /**
   * Varsayilan pencerede satin alinacak KAYIT sayisi (kisi x alan).
   *
   * Ucretin carpani budur; havuz buyuklugu degil. Istenen alanda verisi
   * olmayan kisi icin odeme yapilmaz.
   */
  records: number;
  /** Guncel ucret (token'in en kucuk biriminde). */
  fee: bigint;
  balance: bigint;
  allowance: bigint;
  decimals: number;
  symbol: string;
  /** Ucu de saglaniyorsa sorgu acilabilir. */
  ready: boolean;
}

export async function readResearcherReadiness(
  runner: BrowserProvider | Signer,
  account: string,
): Promise<ResearcherReadiness> {
  const payments = getPayments(runner);
  const token = getPaymentToken(runner);
  const registry = new Contract(CONTRACTS.VeriArfyRegistry, REGISTRY_ABI, runner);

  const paymentsAddress = await payments.getAddress();

  const protocol = getProtocol(runner);

  const [registered, quote, poolCount, balance, allowance, decimals, symbol] =
    await Promise.all([
      registry.isRegistered(account),
      payments.quote(),
      protocol.participantCount(),
      token.balanceOf(account),
      token.allowance(account, paymentsAddress),
      token.decimals(),
      token.symbol(),
    ]);

  const fee: bigint = quote[0];
  const records = Number(quote[1]);
  // Sorgunun acilabilmesi HAVUZUN dolu olmasina baglidir; kayit sayisi
  // ucreti belirler ama tek basina kapi degildir.
  const participants = Number(poolCount);

  return {
    registered,
    participants,
    records,
    fee,
    balance,
    allowance,
    decimals: Number(decimals),
    symbol,
    ready: registered && participants > 0 && balance >= fee,
  };
}

/**
 * Dugumun ONAY VEREBILME durumu.
 *
 * @remarks "Yetkili dugum" olmak YETMEZ. Onay icin teminat da gerekir ve
 *          gereken teminat havuzun ekonomik degeriyle BUYUR:
 *
 *              minStake = baseStake x log2(toplamUcret / esik)
 *
 *          Yani dun yeten bir teminat, birkac sorgu sonra yetmeyebilir.
 *          Sozlesme bunu `NodeNotStaked` ile reddediyor; eksik onceden
 *          okunmazsa kullanici cozulemeyen bir revert gorur.
 */
export interface NodeStakeState {
  canApprove: boolean;
  staked: bigint;
  required: bigint;
  banned: boolean;
  /** Eksik teminat; 0 ise sorun yok. */
  shortfall: bigint;
}

export async function readNodeStake(
  runner: BrowserProvider | Signer,
  node: string,
): Promise<NodeStakeState | null> {
  const protocol = getProtocol(runner);
  const module: string = await protocol.stakingModule();
  if (!module || module === ZERO_ADDRESS) return null;

  const staking = new Contract(module, STAKING_ABI, runner);
  const [canApprove, staked, required, banned] = await Promise.all([
    staking.canApprove(node),
    staking.stakeOf(node),
    staking.minStake(),
    staking.isBanned(node),
  ]);

  const stakedWei = BigInt(staked);
  const requiredWei = BigInt(required);

  return {
    canApprove,
    staked: stakedWei,
    required: requiredWei,
    banned,
    shortfall: stakedWei >= requiredWei ? 0n : requiredWei - stakedWei,
  };
}

/** Teminat yatirir (eksigi tamamlamak icin). */
export async function stakeNode(signer: Signer, amountWei: bigint): Promise<TxOutcome> {
  const protocol = getProtocol(signer);
  const module: string = await protocol.stakingModule();
  const staking = new Contract(module, STAKING_ABI, signer);

  const tx = await staking.stake({ value: amountWei });
  const receipt = await tx.wait();
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    handles: [],
  };
}

/**
 * Arastirmacinin ACIK (henuz bolusturulmemis) son sorgusunu bulur.
 *
 * @remarks NEDEN GEREKLI: sayfa yenilendiginde arayuz acik talebi unutuyor
 *          ve "ucreti ode" butonu yeniden etkinlesiyordu. Kullanici, zaten
 *          odenmis ve onaylanmis bir talep dururken ikinci kez ucret oduyor.
 *          Zincirde durum zaten yaziyor — sormamak, kullaniciya bosuna para
 *          harcatmakti.
 *
 * @returns En yeni acik sorgu, yoksa `null`.
 */
export async function findOpenQuery(
  runner: BrowserProvider | Signer,
  researcher: string,
): Promise<{ queryId: number; requestId: number; fee: bigint } | null> {
  const payments = getPayments(runner);
  const total = Number(await payments.nextQueryId());

  // En yeniden geriye; ilk uyan doner. Sinirli tarama: panelin acilisini
  // yavaslatmamak icin son 25 sorgu yeterli.
  const oldest = Math.max(0, total - 25);
  for (let id = total - 1; id >= oldest; id--) {
    const q = await payments.query(id);
    if ((q.researcher as string).toLowerCase() !== researcher.toLowerCase()) continue;
    if (q.settled || q.refunded) continue;

    return {
      queryId: id,
      requestId: Number(q.disclosureRequestId),
      fee: q.fee as bigint,
    };
  }
  return null;
}
