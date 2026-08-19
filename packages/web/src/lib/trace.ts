/**
 * Dogrulama izi — "gercekten calisiyor mu" sorusunun tek yaniti.
 *
 * # Neden var
 *
 * Sifreli bir sistemde ekranda gorunen hicbir sey kendini kanitlamaz: "veri
 * sifrelendi" yazan bir etiket, hicbir sey yapmadan da yazilabilir. Bu yuzden
 * her adim, ZINCIRDEN YA DA SIFRELEME KATMANINDAN gelen somut bir KANIT
 * birakir: islem ozeti, blok numarasi, harcanan gaz, ciphertext handle'i,
 * yeniden okunmus zincir degeri.
 *
 * Kanit alanlari uydurulmaz — hepsi gercek cagrilardan doner. Bir adim kanit
 * uretemiyorsa `ok` olamaz.
 */

export type EvidenceKind =
  /** Zincir islemi — Etherscan baglantisi verilir. */
  | "tx"
  /** Kontrat ya da cuzdan adresi. */
  | "address"
  /** 32 baytlik ozet (panel ozeti, CID digest...). */
  | "hash"
  /** fhEVM ciphertext handle'i — sifreli degerin zincirdeki kimligi. */
  | "handle"
  /** Olculen ya da zincirden geri okunan sayi. */
  | "value"
  /** Duz aciklama. */
  | "note";

export interface Evidence {
  kind: EvidenceKind;
  label: string;
  value: string;
  /** Etherscan / IPFS baglantisi. */
  href?: string;
  /**
   * Zincirden GERI OKUNARAK dogrulanmis mi?
   *
   * Ayri bir alan olmasinin sebebi: "gonderdim" ile "zincir oyle diyor" ayni
   * sey degildir. Yalnizca ikincisi kanittir.
   */
  verified?: boolean;
}

export type StepStatus = "pending" | "running" | "ok" | "fail";

export interface TraceStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  evidence: Evidence[];
  startedAt?: number;
  endedAt?: number;
}

/** Adimin sureci (ms) — bitmediyse `null`. */
export function stepDuration(step: TraceStep): number | null {
  if (step.startedAt === undefined || step.endedAt === undefined) return null;
  return step.endedAt - step.startedAt;
}

export const EXPLORER = "https://sepolia.etherscan.io";

export const txEvidence = (label: string, hash: string): Evidence => ({
  kind: "tx",
  label,
  value: hash,
  href: `${EXPLORER}/tx/${hash}`,
  verified: true,
});

export const addressEvidence = (label: string, address: string): Evidence => ({
  kind: "address",
  label,
  value: address,
  href: `${EXPLORER}/address/${address}`,
});

export const valueEvidence = (
  label: string,
  value: string | number,
  verified = false,
): Evidence => ({ kind: "value", label, value: String(value), verified });

export const noteEvidence = (label: string, value: string): Evidence => ({
  kind: "note",
  label,
  value,
});

export const handleEvidence = (label: string, handle: string): Evidence => ({
  kind: "handle",
  label,
  value: handle,
});

export const hashEvidence = (
  label: string,
  hash: string,
  verified = false,
): Evidence => ({ kind: "hash", label, value: hash, verified });

/** Uzun onaltiliklari okunabilir kisaltmaya cevirir. */
export function shorten(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
