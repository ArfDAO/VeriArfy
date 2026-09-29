/**
 * E/19 klinik yigininin canli durumu.
 *
 * Bu modul var cunku klinik onam ekrani durumunu SABIT YAZILMIS bir rozetle
 * anlatiyordu ("DEPLOY EDILMEDI"). Metin yazildigi gun dogruydu; E/19 Sepolia'ya
 * dagitildiktan sonra da oylece kaldi ve sayfa var olan bir sistemi yok
 * gostermeye basladi. Bir kez yazilip bir daha bakilmayan durum metinleri hep
 * boyle bozulur, bu yuzden durum artik zincirden okunuyor.
 */
import { Contract } from "ethers";

import e19Deployment from "../config/e19-deployment.json";
import { publicProvider } from "./protocol";

const E19_PROTOCOL_ABI = ["function participantCount() view returns (uint32)"];

export interface E19Status {
  /** Kontratlarin dagitildigi blok; dagitim kaydi yoksa null. */
  deployedAtBlock: number | null;
  /** Zincirden okunan katilimci sayisi; okunamazsa null. */
  participants: number | null;
  /** Dagitim kaydindaki hedef kohort buyuklugu. */
  participantTarget: number | null;
  /** Yalnizca sentetik kohort mu. */
  syntheticOnly: boolean;
  protocolAddress: string | null;
  /** Zincire hic ulasilamadi mi (dagitim var ama okuma basarisiz). */
  unreachable: boolean;
}

export const E19_DEPLOYMENT = e19Deployment as {
  syntheticOnly?: boolean;
  deployedAtBlock?: number;
  contracts?: Record<string, string>;
  liveSettlement?: { participantTarget?: number };
};

export function e19IsDeployed(): boolean {
  return Boolean(E19_DEPLOYMENT.contracts?.VeriarfyProtocolE19);
}

export async function readE19Status(): Promise<E19Status> {
  const protocolAddress = E19_DEPLOYMENT.contracts?.VeriarfyProtocolE19 ?? null;
  const base: E19Status = {
    deployedAtBlock: E19_DEPLOYMENT.deployedAtBlock ?? null,
    participants: null,
    participantTarget: E19_DEPLOYMENT.liveSettlement?.participantTarget ?? null,
    syntheticOnly: E19_DEPLOYMENT.syntheticOnly !== false,
    protocolAddress,
    unreachable: false,
  };

  if (!protocolAddress) return base;

  try {
    const contract = new Contract(protocolAddress, E19_PROTOCOL_ABI, publicProvider());
    const count = (await contract.participantCount()) as bigint;
    return { ...base, participants: Number(count) };
  } catch {
    // Okuyamamak "dagitilmamis" DEMEK DEGILDIR. Ikisini karistirmak, bu
    // ekranin en basta yaptigi hatanin tekrari olurdu.
    return { ...base, unreachable: true };
  }
}
