import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, ZeroAddress } from "ethers";

import { parseAuthorizedNodeAddresses } from "./node-addresses";

export const D15_PROFILE_ID = "d15-sepolia-2of2-ml";
export type D15NodeRole = "node-1" | "node-2";

export interface D15Profile {
  profile: typeof D15_PROFILE_ID;
  network: "sepolia";
  chainId: 11155111;
  publicRpcUrl: string;
  deployer: string;
  authorizedNodes: [string, string];
  queryType: 2;
  minParticipants: 1;
  nodeBaseStakeWei: bigint;
  minimumDeployerBalanceWei: bigint;
}

function recordOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("D15 profile object olmalidir");
  }
  return raw as Record<string, unknown>;
}

function positiveWei(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${field} pozitif decimal wei string olmalidir`);
  }
  return BigInt(raw);
}

export function parseD15Profile(raw: unknown): D15Profile {
  const value = recordOf(raw);

  if (value.profile !== D15_PROFILE_ID) {
    throw new Error(`D15 profile '${D15_PROFILE_ID}' olmalidir`);
  }
  if (value.network !== "sepolia" || value.chainId !== 11155111) {
    throw new Error("D15 profile yalniz Sepolia chainId 11155111 icindir");
  }
  if (value.queryType !== 2 || value.minParticipants !== 1) {
    throw new Error("D15 profile 2-node ML ve MIN_PARTICIPANTS=1 olmali");
  }

  let publicRpcUrl: URL;
  try {
    publicRpcUrl = new URL(String(value.publicRpcUrl));
  } catch {
    throw new Error("D15 publicRpcUrl gecersiz");
  }
  if (publicRpcUrl.protocol !== "https:") {
    throw new Error("D15 publicRpcUrl HTTPS olmali");
  }

  let deployer: string;
  try {
    deployer = getAddress(String(value.deployer));
  } catch {
    throw new Error("D15 deployer adresi gecersiz");
  }
  if (deployer === ZeroAddress) throw new Error("D15 deployer zero adres olamaz");

  if (!Array.isArray(value.authorizedNodes)) {
    throw new Error("D15 authorizedNodes array olmalidir");
  }
  const authorizedNodes = parseAuthorizedNodeAddresses(value.authorizedNodes.join(","));
  if (authorizedNodes.length !== 2) {
    throw new Error("D15 profile tam iki node icermelidir");
  }
  if (authorizedNodes.some((node) => node.toLowerCase() === deployer.toLowerCase())) {
    throw new Error("D15 deployer node adreslerinden farkli olmalidir");
  }

  return {
    profile: D15_PROFILE_ID,
    network: "sepolia",
    chainId: 11155111,
    publicRpcUrl: publicRpcUrl.toString(),
    deployer,
    authorizedNodes: [authorizedNodes[0], authorizedNodes[1]],
    queryType: 2,
    minParticipants: 1,
    nodeBaseStakeWei: positiveWei(value.nodeBaseStakeWei, "nodeBaseStakeWei"),
    minimumDeployerBalanceWei: positiveWei(
      value.minimumDeployerBalanceWei,
      "minimumDeployerBalanceWei",
    ),
  };
}

export function loadD15Profile(): D15Profile {
  const path = join(__dirname, "..", "ops", "d15-sepolia.json");
  return parseD15Profile(JSON.parse(readFileSync(path, "utf8")));
}

export function parseD15NodeRole(raw: string | undefined): D15NodeRole {
  const role = raw?.trim();
  if (role !== "node-1" && role !== "node-2") {
    throw new Error("D15_NODE_ROLE node-1 veya node-2 olmalidir");
  }
  return role;
}

export function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
