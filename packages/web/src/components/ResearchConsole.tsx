import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider, Signer } from "ethers";
// @ts-expect-error — JS paketi, tip bildirimi yok.
import { benjaminiHochberg, chiSquareTest, compareGroups, formatP } from "@veriarfy/study";

import { formatEther, parseEther } from "ethers";

import { CONTRACTS, explorerAddress } from "../config";
import {
  QUERY_TYPE,
  approveDisclosure,
  collectDisclosureHandles,
  executeDisclosure,
  findOpenQuery,
  getProtocol,
  openQuery,
  readDisclosure,
  readNodeStake,
  readResearcherReadiness,
  stakeNode,
  settleQuery,
  type DisclosureState,
  type NodeStakeState,
  type ResearcherReadiness,
} from "../lib/protocol";
import { userDecrypt } from "../lib/fhe";
import { decodeAggregate, type MetricSpec } from "../lib/metrics";
import { GENOMIC_PANEL, METRIC_PANEL } from "../lib/studyPanel";
import { connectWallet, ensureSepolia, hasWallet, shortAddress } from "../lib/wallet";
import { useTrace } from "../lib/useTrace";
import { noteEvidence, txEvidence, valueEvidence } from "../lib/trace";
import { TraceConsole } from "./TraceConsole";

/**
 * Arastirma konsolu — sifreli verinin GERCEKTEN kullanildigi yer.
 *
 * # Akis (rapor §2.6, BSKK-44)
 *
 *   1. ODEME      arastirmaci ucreti oder; ucret EMANETTE bekler.
 *   2. TALEP      odeme sozlesmesi (sorgu kapisi) acilim talebini acar.
 *   3. ONAY       yetkili dugumler M-of-N onaylar. Esige ulasilana kadar
 *                 hicbir sey cozulemez.
 *   4. ITIRAZ     esikten sonra bir sure acik kalir. `FHE.allow` GERI
 *                 ALINAMAZ oldugu icin itiraz izinden ONCE gelmek zorunda.
 *   5. YURUTME    cozum yetkisi ARASTIRMACIYA verilir.
 *   6. COZUM      tarayicida, arastirmacinin imzasiyla (`userDecrypt`).
 *   7. ISTATISTIK ki-kare (genomik) + Welch t (biyobelirtec), duz metinde.
 *
 * # Cozulen sey BIREYIN verisi degildir
 *
 * Acilan handle'lar grup TOPLAMLARIDIR: kontenjans hucreleri ve
 * (n, Sum x, Sum x^2). Kimsenin dozaji ya da VO2 max degeri hicbir asamada
 * duz metne donmez. k-anonimlik esigi de bunun altinda ayrica durur.
 */

const GROUP_LABEL = ["Kontrol", "Vaka"];

interface SnpResult {
  snp: number;
  rsid: string;
  table: number[][];
  chi2: number;
  df: number;
  p: number;
  pAdjusted: number;
  total: number;
  minExpected: number;
  reliable: boolean;
}

interface MetricResult {
  metric: number;
  code: string;
  unit: string;
  control: { n: number; mean: number; sd: number };
  cases: { n: number; mean: number; sd: number };
  t: number;
  p: number;
  cohensD: number;
  note: string | null;
}

export function ResearchConsole() {
  const trace = useTrace();

  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isNode, setIsNode] = useState(false);
  const [readiness, setReadiness] = useState<ResearcherReadiness | null>(null);
  const [stake, setStake] = useState<NodeStakeState | null>(null);

  // Arastirmacinin SECTIGI alanlar. Varsayilan: hepsi — ama secim onun.
  const [snpPick, setSnpPick] = useState<Set<number>>(
    () => new Set(GENOMIC_PANEL.variants.map((_, i) => i)),
  );
  const [metricPick, setMetricPick] = useState<Set<number>>(
    () => new Set(METRIC_PANEL.metrics.map((_, i) => i)),
  );

  const [queryId, setQueryId] = useState<number | null>(null);
  const [requestId, setRequestId] = useState<number | null>(null);
  const [state, setState] = useState<DisclosureState | null>(null);

  const [snpResults, setSnpResults] = useState<SnpResult[] | null>(null);
  const [metricResults, setMetricResults] = useState<MetricResult[] | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queryType = QUERY_TYPE.STATISTICS;

  const connect = useCallback(async () => {
    setError(null);
    trace.begin("wallet", "Araştırmacı cüzdanı bağlandı");
    try {
      const { provider: p, address: who, chainId } = await connectWallet();
      if (chainId !== 11155111) await ensureSepolia();
      const s = await p.getSigner();

      setProvider(p);
      setSigner(s);
      setAddress(who);

      const node = await getProtocol(p).isAuthorizedNode(who);
      setIsNode(node);

      // ON KOSULLAR — sozlesme ucunu de revert ile zorluyor. Onceden
      // okunmasalar, kullanici sebebi anlasilmayan bir islem hatasi gorurdu.
      const ready = await readResearcherReadiness(p, who);
      setReadiness(ready);

      // YETKILI OLMAK YETMEZ: onay icin teminat da gerekir ve gereken
      // teminat havuzun degeriyle buyur. Onceden okunmazsa kullanici
      // `NodeNotStaked` diye cozulemeyen bir revert gorur.
      const stakeState = node ? await readNodeStake(p, who) : null;
      setStake(stakeState);

      // ACIK TALEBI DEVRAL — yoksa sayfa her yenilendiginde kullanici
      // ayni is icin ikinci kez ucret oder.
      const open = await findOpenQuery(p, who);
      if (open) {
        setQueryId(open.queryId);
        setRequestId(open.requestId);
      }

      const unit = 10 ** ready.decimals;
      trace.succeed("wallet", `${shortAddress(who)}${node ? " · yetkili düğüm" : ""}`, [
        valueEvidence("adres", who),
        valueEvidence("yetkili düğüm mü", node ? "evet" : "hayır", true),
        ...(open
          ? [
              valueEvidence(
                "açık talep devralındı",
                `sorgu #${open.queryId} · talep #${open.requestId}`,
                true,
              ),
            ]
          : []),
        ...(stakeState
          ? [
              valueEvidence(
                "onay verebilir mi",
                stakeState.canApprove ? "evet" : "HAYIR — teminat yetersiz",
                true,
              ),
              valueEvidence(
                "teminat / gereken",
                `${formatEther(stakeState.staked)} / ${formatEther(stakeState.required)} ETH`,
                true,
              ),
            ]
          : []),
        valueEvidence("araştırmacı kaydı", ready.registered ? "var" : "YOK", true),
        valueEvidence("havuzdaki katılımcı", ready.participants, true),
        valueEvidence(
          "satın alınan kayıt",
          `${ready.records} (kişi × alan)`,
          true,
        ),
        valueEvidence(
          "ücret",
          `${(Number(ready.fee) / unit).toFixed(2)} ${ready.symbol}`,
          true,
        ),
        noteEvidence(
          "ücret neye göre",
          "havuz büyüklüğüne değil, istediğiniz alanlarda GERÇEKTEN verisi olan kişi sayısına göre. Az bulunan alan kişi başına daha pahalı (kıtlık çarpanı, tavanlı)",
        ),
        valueEvidence(
          "bakiye",
          `${(Number(ready.balance) / unit).toFixed(2)} ${ready.symbol}`,
          true,
        ),
      ]);
    } catch (err) {
      trace.fail("wallet", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [trace]);

  const refresh = useCallback(
    async (rid: number) => {
      if (!provider) return null;
      const next = await readDisclosure(provider, rid, queryType);
      setState(next);
      return next;
    },
    [provider, queryType],
  );

  /** 1-2. Ücreti öde, talebi aç. */
  const pay = useCallback(async () => {
    if (!signer || !provider) return;
    setBusy("pay");
    setError(null);
    trace.begin("query", "Sorgu ücreti ödendi, açılım talebi açıldı");
    try {
      const { tx, queryId: qid, fee } = await openQuery(signer, queryType, {
        snpIds: [...snpPick].sort((a, b) => a - b),
        metricIds: [...metricPick].sort((a, b) => a - b),
      });
      setQueryId(qid);

      // Talep kimligi sorgu ile ayni sirayla acilir; zincirden okunur.
      const payments = (await import("../lib/protocol")).getPayments(provider);
      const info = await payments.query(qid);
      const rid = Number(info.disclosureRequestId);
      setRequestId(rid);

      trace.succeed("query", `Ücret emanette · sorgu #${qid} · talep #${rid}`, [
        txEvidence("işlem", tx.hash),
        valueEvidence("blok", tx.blockNumber.toLocaleString("tr"), true),
        valueEvidence("ücret", `${(Number(fee) / 1e6).toFixed(2)} tUSD`, true),
        valueEvidence("seçilen SNP", snpPick.size, true),
        valueEvidence("seçilen metrik", metricPick.size, true),
        noteEvidence(
          "ücret nerede",
          "EMANETTE — onay gelmezse iade edilir, açılım gerçekleşirse %80 katılımcılara gider",
        ),
        noteEvidence(
          "neden alan seçiliyor",
          "her araştırmacı aynı veriyle çalışmaz; yalnızca istenen alanlar açılır — hem daha ucuz hem daha az açıklık",
        ),
      ]);

      await refresh(rid);
    } catch (err) {
      trace.fail("query", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, provider, queryType, trace, refresh, snpPick, metricPick]);

  /**
   * Itiraz suresi acikken durumu KENDILIGINDEN tazeler.
   *
   * @remarks Sayac blok ilerledikce dusuyor ama sayfa bunu bilmiyordu;
   *          kullanicinin "durumu oku"ya basip durmasi gerekiyordu. Anket
   *          suresi 20 blok (~4 dakika) — o sure boyunca elle yenilemek
   *          kullaniciyi ekranda bekletmekten baska ise yaramaz.
   *
   *          Yalnizca PENCERE ACIKKEN calisir; is bitince timer kurulmaz.
   */
  useEffect(() => {
    if (requestId === null || !state) return;
    if (!state.finalized || state.revoked || state.executed) return;

    const remaining = state.challengeEndsAtBlock - state.currentBlock;
    if (remaining <= 0) return;

    // Sepolia'da blok ~12 saniye; daha sik sormak RPC'yi bosuna yorar.
    const timer = setInterval(() => void refresh(requestId), 12_000);
    return () => clearInterval(timer);
  }, [requestId, state, refresh]);

  /** Eksik teminatı tamamlar. */
  const topUp = useCallback(async () => {
    if (!signer || !provider || !address || !stake) return;
    setBusy("stake");
    setError(null);
    trace.begin("stake", "Düğüm teminatı tamamlandı");
    try {
      // Tam eksik kadar yatirmak yetmeyebilir: `minStake` her yeni ucretle
      // buyur. %20 pay birakiliyor ki bir sonraki sorgu esigi asmasin.
      const amount = (stake.shortfall * 120n) / 100n;
      const tx = await stakeNode(signer, amount);

      const next = await readNodeStake(provider, address);
      setStake(next);

      trace.succeed("stake", `${formatEther(amount)} ETH yatırıldı`, [
        txEvidence("işlem", tx.hash),
        valueEvidence("yeni teminat", `${formatEther(next?.staked ?? 0n)} ETH`, true),
        valueEvidence("onay verebilir mi", next?.canApprove ? "evet" : "hâlâ hayır", true),
        noteEvidence(
          "neden fazlası yatırıldı",
          "gereken teminat havuzun değeriyle büyür; tam eksik kadar yatırmak bir sonraki ücrette yine yetmezdi",
        ),
      ]);
    } catch (err) {
      trace.fail("stake", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, provider, address, stake, trace]);

  /** 3. Düğüm onayı. */
  const approve = useCallback(async () => {
    if (!signer || requestId === null) return;
    setBusy("approve");
    setError(null);
    trace.begin("approve", "Yetkili düğüm onayı verildi");
    try {
      const tx = await approveDisclosure(signer, requestId);
      const next = await refresh(requestId);

      trace.succeed(
        "approve",
        next
          ? `${next.approvals}/${next.requiredApprovals} onay${next.finalized ? " · EŞİĞE ULAŞILDI" : ""}`
          : "onay verildi",
        [
          txEvidence("işlem", tx.hash),
          valueEvidence("onay", `${next?.approvals}/${next?.requiredApprovals}`, true),
          ...(next?.finalized
            ? [
                valueEvidence(
                  "itiraz süresi biter",
                  `blok ${next.challengeEndsAtBlock.toLocaleString("tr")}`,
                  true,
                ),
                noteEvidence(
                  "itiraz neden izinden önce",
                  "FHE.allow GERİ ALINAMAZ; izin verildikten sonra itiraz anlamsız kalırdı",
                ),
              ]
            : []),
        ],
      );
    } catch (err) {
      trace.fail("approve", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, requestId, trace, refresh]);

  /** 5. Çözüm yetkisini ver. */
  const execute = useCallback(async () => {
    if (!signer || requestId === null) return;
    setBusy("execute");
    setError(null);
    trace.begin("execute", "Çözüm yetkisi araştırmacıya verildi");
    try {
      const tx = await executeDisclosure(signer, requestId);
      await refresh(requestId);
      trace.succeed("execute", "FHE.allow yazıldı — geri alınamaz", [
        txEvidence("işlem", tx.hash),
        valueEvidence("gaz", Number(tx.gasUsed).toLocaleString("tr"), true),
        noteEvidence(
          "yetki kime",
          "yalnızca araştırmacının adresine — onaylayan düğümler sonucu göremez",
        ),
      ]);
    } catch (err) {
      trace.fail("execute", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, requestId, trace, refresh]);

  /** 6-7. Çöz ve istatistiği hesapla. */
  const analyze = useCallback(async () => {
    if (!signer || !provider || !state) return;
    setBusy("analyze");
    setError(null);

    trace.begin("decrypt", "Şifreli toplamlar çözüldü (araştırmacı imzasıyla)");
    try {
      const { contingency, biomarkers, pairs } = await collectDisclosureHandles(
        provider,
        state,
      );

      const clear = await userDecrypt(pairs, signer as any, (index, total) => {
        trace.progress("decrypt", `parti ${index}/${total} çözülüyor…`);
      });
      const read = (h: string) => Number(clear[h.toLowerCase()] ?? 0n);

      trace.succeed("decrypt", `${pairs.length} şifreli değer çözüldü`, [
        valueEvidence("çözülen handle", pairs.length, true),
        valueEvidence(
          "toplam şifreli bit",
          pairs.reduce((n, p) => n + p.bits, 0),
          true,
        ),
        noteEvidence(
          "neden partili",
          "relayer tek istekte en fazla 2048 şifreli bit çözüyor; imza tek kalıyor çünkü EIP-712 handle'ları değil anahtarı ve süreyi imzalar",
        ),
        valueEvidence("seçilen SNP", state.snpIds.length, true),
        valueEvidence("seçilen metrik", state.metricIds.length, true),
        noteEvidence(
          "çözülen ne",
          "grup TOPLAMLARI — hiçbir bireyin dozajı ya da ölçümü düz metne dönmedi",
        ),
      ]);

      // --- Genomik: ki-kare -------------------------------------------------
      trace.begin("gwas", "Ki-kare hesaplandı (genomik)");
      const raw = contingency.map(({ snp, cells }) => {
        const table = cells.map((row) => row.map(read));
        return { snp, table, ...chiSquareTest(table) };
      });
      const adjusted = benjaminiHochberg(raw.map((r: any) => r.p));

      const snps: SnpResult[] = raw.map((r: any, i: number) => ({
        snp: r.snp,
        rsid: GENOMIC_PANEL.variants[r.snp]?.rsid ?? `#${r.snp}`,
        table: r.table,
        chi2: r.chi2,
        df: r.df,
        p: r.p,
        pAdjusted: adjusted[i],
        total: r.total,
        minExpected: r.minExpected,
        reliable: r.reliable,
      }));
      setSnpResults(snps);

      const significant = snps.filter((s) => s.pAdjusted < 0.05).length;
      trace.succeed("gwas", `${snps.length} varyant · ${significant} tanesi FDR<0,05`, [
        valueEvidence("toplam gözlem", snps[0]?.total ?? 0, true),
        noteEvidence(
          "çoklu test",
          "Benjamini-Hochberg (FDR) uygulandı — düzeltilmemiş p ile 20 SNP'nin 1'i tesadüfen anlamlı çıkar",
        ),
      ]);

      // --- Biyobelirteç: Welch t -------------------------------------------
      if (biomarkers.length > 0) {
        trace.begin("welch", "Welch t-testi hesaplandı (biyobelirteç)");

        const byMetric = new Map<number, Record<number, { n: number; sum: number; sumSq: number }>>();
        for (const b of biomarkers) {
          const entry = byMetric.get(b.metric) ?? {};
          entry[b.group] = { n: read(b.count), sum: read(b.sum), sumSq: read(b.sumSq) };
          byMetric.set(b.metric, entry);
        }

        const results: MetricResult[] = [];
        for (const [metric, groups] of byMetric) {
          const spec = METRIC_PANEL.metrics[metric] as MetricSpec | undefined;
          if (!spec) continue;

          const control = groups[0] ?? { n: 0, sum: 0, sumSq: 0 };
          const cases = groups[1] ?? { n: 0, sum: 0, sumSq: 0 };

          // t ve p, KODLANMIS toplamlardan hesaplanir; olcek ve offset
          // sadelestigi icin sonuc gercek degerlerden hesaplananla aynidir.
          const comparison = compareGroups(control, cases);

          results.push({
            metric,
            code: spec.code,
            unit: spec.unit,
            control: decodeAggregate(control, spec),
            cases: decodeAggregate(cases, spec),
            t: comparison.t,
            p: comparison.p,
            cohensD: comparison.cohensD,
            note: comparison.note,
          });
        }
        setMetricResults(results);

        trace.succeed("welch", `${results.length} metrik karşılaştırıldı`, [
          noteEvidence(
            "ölçek neden sonucu değiştirmiyor",
            "offset varyanstan düşer, ölçek t'de sadeleşir — kodlanmış toplamdan çıkan t ve p, gerçek değerlerden çıkanla aynı",
          ),
        ]);
      }
    } catch (err) {
      trace.fail(state ? "decrypt" : "decrypt", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, provider, state, trace]);

  /** 8. Ücreti bölüştür. */
  const settle = useCallback(async () => {
    if (!signer || queryId === null) return;
    setBusy("settle");
    setError(null);
    trace.begin("settle", "Ücret bölüştürüldü");
    try {
      const tx = await settleQuery(signer, queryId);
      trace.succeed("settle", "%80 katılımcılara, %20 hazineye", [
        txEvidence("işlem", tx.hash),
        valueEvidence("gaz", Number(tx.gasUsed).toLocaleString("tr"), true),
      ]);
    } catch (err) {
      trace.fail("settle", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [signer, queryId, trace]);

  const blocksLeft =
    state && state.challengeEndsAtBlock > 0
      ? Math.max(0, state.challengeEndsAtBlock - state.currentBlock)
      : null;

  /** Kalan bloktan kaba sure — Sepolia'da blok ~12 saniye. */
  const secondsLeft = blocksLeft === null ? null : blocksLeft * 12;

  return (
    <div className="contribute">
      <div className="contribute__flow">
        {/* --- Cuzdan --- */}
        <div className="card">
          <div className="card__head">
            <h3>0 · Araştırmacı cüzdanı</h3>
            {address && (
              <span className="badge badge--ok">
                {shortAddress(address)}
                {isNode && " · düğüm"}
              </span>
            )}
          </div>

          {!hasWallet() ? (
            <div className="notice notice--warn">
              Ethereum cüzdanı bulunamadı.
            </div>
          ) : !address ? (
            <>
              <p className="card__body">
                Bu panel araştırmacı tarafını yürütür: ücreti öder, eşikli onayı
                bekler, süre dolunca çözüm yetkisini alır ve şifreli toplamları
                çözüp istatistiği hesaplar.
              </p>
              <button className="pill pill--primary" style={{ marginTop: 16 }} onClick={() => void connect()}>
                Cüzdanı bağla
              </button>
            </>
          ) : (
            <div className="kv">
              <div className="kv__row">
                <span className="eyebrow">ARAŞTIRMACI KAYDI</span>
                <span className="mono">
                  {readiness?.registered ? "var ✓" : "YOK — ZK kimlik kanıtı gerekli"}
                </span>
              </div>
              <div className="kv__row">
                <span className="eyebrow">HAVUZDAKİ KATILIMCI</span>
                <span className="mono">
                  {readiness?.participants ?? "—"}
                  {readiness?.participants === 0 && " — sorgu açılamaz"}
                </span>
              </div>
              <div className="kv__row">
                <span className="eyebrow">SATIN ALINAN KAYIT</span>
                <span className="mono">
                  {readiness ? `${readiness.records} (kişi × alan)` : "—"}
                </span>
              </div>
              <div className="kv__row">
                <span className="eyebrow">ÜCRET / BAKİYE</span>
                <span className="mono">
                  {readiness
                    ? `${(Number(readiness.fee) / 10 ** readiness.decimals).toFixed(2)} / ` +
                      `${(Number(readiness.balance) / 10 ** readiness.decimals).toFixed(2)} ${readiness.symbol}`
                    : "—"}
                </span>
              </div>
              <div className="kv__row">
                <span className="eyebrow">PROTOKOL</span>
                <a
                  className="mono trace__link"
                  href={explorerAddress(CONTRACTS.VeriarfyProtocol)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {CONTRACTS.VeriarfyProtocol.slice(0, 10)}…
                </a>
              </div>
              <div className="kv__row">
                <span className="eyebrow">SORGU TİPİ</span>
                <span className="mono">genel istatistik (4/10 eşik)</span>
              </div>
            </div>
          )}
        </div>

        {/* --- Akis --- */}
        {address && (
          <div className="card">
            <div className="card__head">
              <h3>1 · Eşikli açılım (BSKK-44)</h3>
              {state && (
                <span className={state.finalized ? "badge badge--ok" : "badge"}>
                  {state.approvals}/{state.requiredApprovals} onay
                </span>
              )}
            </div>

            <p className="card__body">
              Eşiğe ulaşılmadan hiçbir şey çözülemez. Eşikten sonra da bir
              itiraz süresi vardır: <strong>FHE.allow geri alınamaz</strong>,
              bu yüzden itiraz izinden <em>önce</em> gelmek zorunda.
            </p>

            {isNode && stake && !stake.canApprove && (
              <div className="notice notice--warn">
                <strong>Yetkili düğümsünüz ama onay veremezsiniz:</strong> teminat{" "}
                <span className="mono">{formatEther(stake.staked)}</span> ETH, gereken{" "}
                <span className="mono">{formatEther(stake.required)}</span> ETH.
                {stake.banned && " Düğüm YASAKLI."}
                <br />
                Gereken teminat havuzun ekonomik değeriyle birlikte büyür
                (<span className="mono">minStake = baseStake × log2(toplamÜcret / eşik)</span>) —
                yani dün yeten bir teminat bugün yetmeyebilir. Tasarım gereği:
                açılabilecek veri değerlendikçe düğümün riske attığı miktar da artmalı.
              </div>
            )}

            {requestId !== null && (
              <div className="notice notice--info">
                Bu adresin <strong>açık bir talebi</strong> var (sorgu #{queryId} ·
                talep #{requestId}) ve ücreti ödenmiş durumda. Yeni ücret ödemeye
                gerek yok — aşağıdan bu talebi ilerletin.
              </div>
            )}

            {readiness && !readiness.ready && (
              <div className="notice notice--warn">
                Sorgu açılamaz — sözleşme şunları şart koşuyor:
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {!readiness.registered && (
                    <li>
                      Araştırmacı defterine <strong>kayıt</strong> (ZK kimlik kanıtı).
                    </li>
                  )}
                  {readiness.participants === 0 && (
                    <li>
                      <strong>Havuz boş</strong> — en az bir katılımcı veri yüklemeli.
                    </li>
                  )}
                  {readiness.balance < readiness.fee && (
                    <li>
                      Yetersiz <strong>{readiness.symbol}</strong> bakiyesi.
                    </li>
                  )}
                </ul>
              </div>
            )}

            {requestId === null && (
              <div className="picker">
                <div className="picker__head">
                  <span className="eyebrow">HANGİ VERİYE İHTİYACINIZ VAR?</span>
                  <span className="eyebrow">
                    {snpPick.size} SNP · {metricPick.size} METRİK
                  </span>
                </div>
                <p className="card__body" style={{ marginBottom: 12 }}>
                  Yalnızca seçtiğiniz alanlar açılır. Ödeme de buna göre
                  dağıtılır: <strong>o alanlara gerçekten veri vermiş
                  katılımcılar</strong>, verdikleri alan sayısı kadar pay alır.
                </p>

                <div className="chips">
                  {GENOMIC_PANEL.variants.map((v, i) => (
                    <button
                      key={v.rsid}
                      type="button"
                      className={snpPick.has(i) ? "chip chip--on" : "chip"}
                      onClick={() =>
                        setSnpPick((prev) => {
                          const next = new Set(prev);
                          next.has(i) ? next.delete(i) : next.add(i);
                          return next;
                        })
                      }
                    >
                      {v.rsid}
                    </button>
                  ))}
                </div>

                <div className="chips" style={{ marginTop: 8 }}>
                  {METRIC_PANEL.metrics.map((m, i) => (
                    <button
                      key={m.code}
                      type="button"
                      className={metricPick.has(i) ? "chip chip--on" : "chip"}
                      onClick={() =>
                        setMetricPick((prev) => {
                          const next = new Set(prev);
                          next.has(i) ? next.delete(i) : next.add(i);
                          return next;
                        })
                      }
                    >
                      {m.code}
                    </button>
                  ))}
                </div>

                {snpPick.size === 0 && (
                  <div className="notice notice--warn">
                    En az bir SNP seçilmeli — her çalışmanın en az bir varyantı
                    vardır.
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ marginTop: 16 }}>
              <button
                className="pill pill--primary"
                onClick={() => void pay()}
                disabled={
                  !!busy || requestId !== null || !readiness?.ready || snpPick.size === 0
                }
              >
                {busy === "pay" ? "ödeniyor…" : "Ücreti öde ve talebi aç"}
              </button>

              {requestId !== null && isNode && state && !state.finalized && (
                <button
                  className="pill pill--primary"
                  onClick={() => void approve()}
                  disabled={!!busy || stake?.canApprove === false}
                >
                  {busy === "approve" ? "onaylanıyor…" : "Düğüm olarak onayla"}
                </button>
              )}

              {isNode && stake && !stake.canApprove && !stake.banned && (
                <button className="pill pill--primary" onClick={() => void topUp()} disabled={!!busy}>
                  {busy === "stake"
                    ? "yatırılıyor…"
                    : `Teminatı tamamla (${formatEther((stake.shortfall * 120n) / 100n)} ETH)`}
                </button>
              )}

              {state?.canExecute && (
                <button className="pill pill--primary" onClick={() => void execute()} disabled={!!busy}>
                  {busy === "execute" ? "yürütülüyor…" : "Çözüm yetkisini ver"}
                </button>
              )}

              {requestId !== null && (
                <button
                  className="pill pill--ghost"
                  onClick={() => void refresh(requestId)}
                  disabled={!!busy}
                >
                  ↻ durumu oku
                </button>
              )}
            </div>

            {state && (
              <div className="kv" style={{ marginTop: 16 }}>
                <div className="kv__row">
                  <span className="eyebrow">TALEP</span>
                  <span className="mono">
                    #{state.requestId} · {state.snapshotCount} katılımcı dondurulmuş
                  </span>
                </div>
                <div className="kv__row">
                  <span className="eyebrow">DURUM</span>
                  <span className="mono">
                    {state.revoked
                      ? "İTİRAZ KABUL EDİLDİ — iptal"
                      : !state.finalized
                        ? "onay bekliyor"
                        : blocksLeft && blocksLeft > 0
                          ? `itiraz süresi açık · ${blocksLeft} blok (~${Math.ceil(
                              (secondsLeft ?? 0) / 60,
                            )} dk) kaldı`
                          : state.executed
                            ? "çözüm yetkisi VERİLDİ"
                            : "süre doldu · çözüm yetkisi verilmeli"}
                  </span>
                </div>
                <div className="kv__row">
                  <span className="eyebrow">PENCERE</span>
                  <span className="mono">
                    {state.snpIds
                      .map((i) => GENOMIC_PANEL.variants[i]?.rsid ?? `#${i}`)
                      .join(", ")}
                    {state.metricIds.length > 0 &&
                      ` · ${state.metricIds
                        .map((i) => METRIC_PANEL.metrics[i]?.code ?? `#${i}`)
                        .join(", ")}`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- Cozum ve istatistik --- */}
        {state?.executed && (
          <div className="card">
            <div className="card__head">
              <h3>2 · Çöz ve hesapla</h3>
            </div>
            <p className="card__body">
              Çözülen şey <strong>grup toplamlarıdır</strong> — kontenjans
              hücreleri ve (n, Σx, Σx²). Hiçbir bireyin dozajı ya da ölçümü düz
              metne dönmez.
            </p>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="pill pill--primary" onClick={() => void analyze()} disabled={!!busy}>
                {busy === "analyze" ? "çözülüyor…" : "Şifreli toplamları çöz ve analiz et"}
              </button>
              {queryId !== null && snpResults && (
                <button className="pill pill--ghost" onClick={() => void settle()} disabled={!!busy}>
                  {busy === "settle" ? "bölüştürülüyor…" : "Ücreti bölüştür"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* --- Genomik sonuc --- */}
        {snpResults && (
          <div className="card">
            <div className="card__head">
              <h3>Genomik sonuç — ki-kare</h3>
              <span className="eyebrow">2×3 KONTENJANS · FDR DÜZELTMELİ</span>
            </div>

            <div className="table">
              <div className="table__head table__head--gwas">
                <span>VARYANT</span>
                <span>KONTROL 0/1/2</span>
                <span>VAKA 0/1/2</span>
                <span>χ²</span>
                <span>p</span>
                <span>p (FDR)</span>
              </div>
              {snpResults.map((r) => (
                <div
                  className={
                    r.pAdjusted < 0.05 ? "table__row table__row--gwas is-hit" : "table__row table__row--gwas"
                  }
                  key={r.snp}
                >
                  <span className="mono">{r.rsid}</span>
                  <span className="mono">{r.table[0].join(" / ")}</span>
                  <span className="mono">{r.table[1].join(" / ")}</span>
                  <span className="mono">{Number.isFinite(r.chi2) ? r.chi2.toFixed(2) : "—"}</span>
                  <span className="mono">{formatP(r.p)}</span>
                  <span className="mono">{formatP(r.pAdjusted)}</span>
                </div>
              ))}
            </div>

            {snpResults.some((r) => !r.reliable) && (
              <div className="notice notice--warn">
                Bazı varyantlarda beklenen hücre sayısı 5'in altında. Ki-kare
                yaklaşımı bu durumda güvenilir değildir — sayı gizlenmiyor,
                söyleniyor. Daha fazla katılımcı gerekiyor.
              </div>
            )}
          </div>
        )}

        {/* --- Biyobelirtec sonuc --- */}
        {metricResults && metricResults.length > 0 && (
          <div className="card">
            <div className="card__head">
              <h3>Biyobelirteç sonuç — Welch t-testi</h3>
              <span className="eyebrow">n, Σx, Σx² → ORTALAMA FARKI</span>
            </div>

            <div className="table">
              <div className="table__head table__head--welch">
                <span>METRİK</span>
                <span>KONTROL</span>
                <span>VAKA</span>
                <span>t</span>
                <span>p</span>
              </div>
              {metricResults.map((r) => (
                <div className="table__row table__row--welch" key={r.metric}>
                  <span className="mono">{r.code}</span>
                  <span className="mono">
                    {r.control.n > 0
                      ? `${r.control.mean.toFixed(2)} ± ${r.control.sd.toFixed(2)} (n=${r.control.n})`
                      : "—"}
                  </span>
                  <span className="mono">
                    {r.cases.n > 0
                      ? `${r.cases.mean.toFixed(2)} ± ${r.cases.sd.toFixed(2)} (n=${r.cases.n})`
                      : "—"}
                  </span>
                  <span className="mono">{Number.isFinite(r.t) ? r.t.toFixed(2) : "—"}</span>
                  <span className="mono">{formatP(r.p)}</span>
                </div>
              ))}
            </div>

            {metricResults.some((r) => r.note) && (
              <div className="notice notice--info">
                Bazı metriklerde her iki grupta en az 2 katılımcı yok; t-testi
                hesaplanamıyor. Toplamlar doğru birikiyor, yalnızca örneklem
                yetersiz.
              </div>
            )}
          </div>
        )}

        {error && <div className="notice notice--warn">{error}</div>}
      </div>

      <div className="contribute__trace">
        <TraceConsole steps={trace.steps} title="Araştırma konsolu" />
      </div>
    </div>
  );
}
