import { useCallback, useEffect, useMemo, useState } from "react";

import { SEPOLIA_CHAIN_ID } from "../../config";
import {
  executeDisclosure,
  findOpenQuery,
  formatToken,
  getPayments,
  getPaymentToken,
  QUERY_TYPE,
  readDisclosure,
  settleQuery,
  type DisclosureState,
} from "../../lib/protocol";
import { useSession } from "../../lib/session";

interface QueryPointer {
  queryId: number;
  requestId: number;
}

interface QueryState extends QueryPointer {
  fee: bigint;
  token: { decimals: number; symbol: string };
  settled: boolean;
  refunded: boolean;
  open: boolean;
  disclosure: DisclosureState;
}

type TimelineStatus = "done" | "current" | "pending" | "stopped";

interface TimelineStep {
  title: string;
  detail: string;
  status: TimelineStatus;
}

function storageKey(address: string) {
  return `veriarfy.researcher.last-query.${address.toLowerCase()}`;
}

function readSavedPointer(address: string): QueryPointer | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(address)) ?? "null");
    if (Number.isInteger(parsed?.queryId) && Number.isInteger(parsed?.requestId)) {
      return { queryId: parsed.queryId, requestId: parsed.requestId };
    }
  } catch {
    // Bozuk yerel iz zincir gerceginin yerine gecmez; yeniden okunur.
  }
  return null;
}

function savePointer(address: string, pointer: QueryPointer) {
  window.localStorage.setItem(storageKey(address), JSON.stringify(pointer));
}

function stepsFor(query: QueryState): TimelineStep[] {
  const { disclosure } = query;
  const appealOpen = disclosure.finalized && !disclosure.revoked && !disclosure.executed && disclosure.currentBlock < disclosure.challengeEndsAtBlock;
  const approvalDone = disclosure.finalized || disclosure.executed || query.settled;

  return [
    { title: "Odendi", detail: "Ucret zincirde emanete alindi.", status: "done" },
    {
      title: "Onay bekliyor",
      detail: `${disclosure.approvals}/${disclosure.requiredApprovals} yetkili dugum onayi.`,
      status: query.refunded ? "stopped" : approvalDone ? "done" : "current",
    },
    {
      title: "Itiraz suresi",
      detail: disclosure.finalized ? `Pencere blok ${disclosure.challengeEndsAtBlock.toLocaleString("tr-TR")}de biter.` : "Onay esigi bekleniyor.",
      status: query.refunded ? "stopped" : disclosure.executed || query.settled ? "done" : appealOpen ? "current" : "pending",
    },
    {
      title: "Acilim",
      detail: disclosure.canExecute ? "Itiraz penceresi kapandi; FHE erisimi verilebilir." : "Pencerenin bitmesi bekleniyor.",
      status: query.refunded ? "stopped" : disclosure.executed || query.settled ? "done" : disclosure.canExecute ? "current" : "pending",
    },
    {
      title: "Cozuldu",
      detail: disclosure.executed ? "Cozum yetkisi arastirmaci cuzdani icin zincirde verildi." : "FHE sonucuna erisim henuz verilmedi.",
      status: query.refunded ? "stopped" : query.settled ? "done" : disclosure.executed ? "current" : "pending",
    },
    {
      title: "Dagitildi",
      detail: "Emanet, protokol kurallarina gore katilimcilar ve hazine arasynda dagitilir.",
      status: query.settled ? "done" : query.refunded ? "stopped" : disclosure.executed ? "current" : "pending",
    },
    {
      title: "Iade",
      detail: "Onay/acilim basarisiz kalirsa ucret arastirmaciya iade edilir.",
      status: query.refunded ? "done" : "pending",
    },
  ];
}

function nextAction(query: QueryState): string {
  if (query.refunded) return "Sorgu iade edildi.";
  if (query.settled) return "Odeme dagitildi; sonuc ekranina gecebilirsiniz.";
  if (!query.disclosure.finalized) return "Yetkili dugum onaylari bekleniyor.";
  if (query.disclosure.currentBlock < query.disclosure.challengeEndsAtBlock) {
    return `${query.disclosure.challengeEndsAtBlock - query.disclosure.currentBlock} blokluk itiraz penceresi acik.`;
  }
  if (query.disclosure.canExecute) return "Acilim yetkisi verilmeyi bekliyor.";
  if (query.disclosure.executed) return "Cozum tamam; odemenin dagitilmasi bekliyor.";
  return "Zincir durumu yeniden okunuyor.";
}

export function Sorgular() {
  const { address, chainId, provider, signer } = useSession();
  const [query, setQuery] = useState<QueryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"execute" | "settle" | null>(null);
  const [notice, setNotice] = useState<{ kind: "warn" | "ok" | "info"; text: string } | null>(null);
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setNotice(null);
    try {
      const payments = getPayments(provider);
      const token = getPaymentToken(provider);
      const open = await findOpenQuery(provider, address);
      const pointer = open ?? readSavedPointer(address);
      if (!pointer) {
        setQuery(null);
        return;
      }

      const [payment, disclosure, decimals, symbol] = await Promise.all([
        payments.query(pointer.queryId),
        readDisclosure(provider, pointer.requestId, QUERY_TYPE.STATISTICS),
        token.decimals() as Promise<bigint>,
        token.symbol() as Promise<string>,
      ]);
      if ((payment.researcher as string).toLowerCase() !== address.toLowerCase()) {
        window.localStorage.removeItem(storageKey(address));
        setQuery(null);
        return;
      }

      savePointer(address, pointer);
      setQuery({
        ...pointer,
        fee: payment.fee as bigint,
        token: { decimals: Number(decimals), symbol },
        settled: payment.settled as boolean,
        refunded: payment.refunded as boolean,
        open: !!open,
        disclosure,
      });
    } catch (error) {
      setQuery(null);
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "Sorgu durumu zincirden okunamadi." });
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!query?.open || !provider) return;
    const timer = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(timer);
  }, [provider, query?.open, refresh]);

  const execute = useCallback(async () => {
    if (!signer || !query?.disclosure.canExecute) return;
    setAction("execute");
    setNotice({ kind: "info", text: "FHE acilim yetkisi zincire yaziliyor..." });
    try {
      await executeDisclosure(signer, query.requestId);
      await refresh();
      setNotice({ kind: "ok", text: "Cozum yetkisi verildi; artik odeme dagitilabilir." });
    } catch (error) {
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "Acilim yetkisi verilemedi." });
    } finally {
      setAction(null);
    }
  }, [query, refresh, signer]);

  const settle = useCallback(async () => {
    if (!signer || !query || !query.disclosure.executed || query.settled || query.refunded) return;
    setAction("settle");
    setNotice({ kind: "info", text: "Emanet odemesi protokol kurallarina gore dagitiliyor..." });
    try {
      await settleQuery(signer, query.queryId);
      await refresh();
      setNotice({ kind: "ok", text: "Odeme dagitildi." });
    } catch (error) {
      setNotice({ kind: "warn", text: error instanceof Error ? error.message : "Odeme dagitilamadi." });
    } finally {
      setAction(null);
    }
  }, [query, refresh, signer]);

  const steps = useMemo(() => query ? stepsFor(query) : [], [query]);

  return (
    <section className="research-queries" aria-labelledby="research-queries-title">
      <div className="research-queries__heading">
        <div>
          <span className="eyebrow">ARASTIRMACI / SORGULAR</span>
          <h1 id="research-queries-title">Sorgunuzun zincir ustundeki ilerlemesi</h1>
          <p>Acik sorgu yenilemeden sonra zincirden devralinir. Bu sorgu kapanmadan yeni bir odeme acilamaz.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? "Okunuyor..." : "Yenile"}
        </button>
      </div>

      {wrongNetwork && <div className="notice notice--warn">Sorgu durumu yalnizca Sepolia aginda okunabilir.</div>}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}

      {!loading && !query && (
        <div className="card card--bone">
          <h2>Acik sorgu yok</h2>
          <p className="card__body">Veri satin alma ekranindan alanlari secip sorgu actiginizda, bu zaman cizelgesi zincirden dolacak.</p>
        </div>
      )}

      {query && (
        <div className="research-queries__layout">
          <article className="research-queries__timeline card">
            <div className="research-queries__meta">
              <div><span className="eyebrow">SORGU #{query.queryId}</span><strong className="mono">TALEP #{query.requestId}</strong></div>
              <span className={`badge ${query.open ? "badge--warn" : "badge--ok"}`}>{query.open ? "acik" : query.settled ? "dagitildi" : "iade"}</span>
            </div>
            <ol className="research-queries__steps">
              {steps.map((step, index) => (
                <li className={`research-queries__step is-${step.status}`} key={step.title}>
                  <span className="research-queries__index">{index + 1}</span>
                  <div><strong>{step.title}</strong><p>{step.detail}</p></div>
                  <span className="eyebrow">{step.status === "done" ? "tamam" : step.status === "current" ? "simdi" : step.status === "stopped" ? "atlanmis" : "bekliyor"}</span>
                </li>
              ))}
            </ol>
          </article>

          <aside className="research-queries__next card card--bone">
            <span className="eyebrow">BEKLENEN ADIM</span>
            <h2>{nextAction(query)}</h2>
            <dl className="research-queries__facts">
              <div><dt>Ucret</dt><dd className="mono">{formatToken(query.fee, query.token.decimals, query.token.symbol)}</dd></div>
              <div><dt>Onay</dt><dd>{query.disclosure.approvals}/{query.disclosure.requiredApprovals}</dd></div>
              <div><dt>Guncel blok</dt><dd>{query.disclosure.currentBlock.toLocaleString("tr-TR")}</dd></div>
              {query.disclosure.finalized && <div><dt>Itiraz sonu</dt><dd>{query.disclosure.challengeEndsAtBlock.toLocaleString("tr-TR")}</dd></div>}
              {query.disclosure.finalized && !query.disclosure.executed && query.disclosure.currentBlock < query.disclosure.challengeEndsAtBlock && <div><dt>Kalan blok</dt><dd>{(query.disclosure.challengeEndsAtBlock - query.disclosure.currentBlock).toLocaleString("tr-TR")}</dd></div>}
            </dl>
            {query.disclosure.canExecute && <button className="pill pill--primary" disabled={action !== null} onClick={() => void execute()}>{action === "execute" ? "Yetki veriliyor..." : "Acilim yetkisini ver"}</button>}
            {query.disclosure.executed && !query.settled && !query.refunded && <button className="pill pill--primary" disabled={action !== null} onClick={() => void settle()}>{action === "settle" ? "Dagitiliyor..." : "Odemeyi dagit"}</button>}
          </aside>
        </div>
      )}
    </section>
  );
}
