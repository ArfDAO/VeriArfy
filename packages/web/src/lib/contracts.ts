import { Contract, type BrowserProvider, type Signer } from "ethers";

import { CONTRACTS } from "../config";
import { REGISTRY_ABI, STUDY_ABI } from "../config/abi";

export function getRegistry(runner: BrowserProvider | Signer) {
  return new Contract(CONTRACTS.VeriArfyRegistry, REGISTRY_ABI, runner);
}

export function getStudy(runner: BrowserProvider | Signer) {
  return new Contract(CONTRACTS.AnxietyStudy, STUDY_ABI, runner);
}

/** Bir adresin calisma durumunu okur. */
export async function readParticipantState(
  provider: BrowserProvider,
  address: string,
) {
  const registry = getRegistry(provider);
  const study = getStudy(provider);
  const [registered, submitted, total] = await Promise.all([
    registry.isRegistered(address) as Promise<boolean>,
    study.hasSubmitted(address) as Promise<boolean>,
    study.participantCount() as Promise<bigint>,
  ]);
  return { registered, submitted, participantCount: Number(total) };
}

/**
 * Grup duzeyindeki sifreli toplam handle'larini okur.
 * @returns { anxiety: handles[3][3], panic: handles[3][3] }
 */
export async function readAggregateHandles(provider: BrowserProvider) {
  const study = getStudy(provider);

  async function read(kind: "anxiety" | "panic") {
    const rows: { n: string; sum: string; sumSq: string }[] = [];
    for (let g = 0; g < 3; g++) {
      const res =
        kind === "anxiety"
          ? await study.anxietyAggregate(g)
          : await study.panicAggregate(g);
      rows.push({ n: res[0], sum: res[1], sumSq: res[2] });
    }
    return rows;
  }

  return { anxiety: await read("anxiety"), panic: await read("panic") };
}
