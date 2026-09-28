import { computeAddress } from "ethers";

/** Resolve one D17 signer before dotenv or Hardhat can load unrelated keys. */
export function d17SigningKey(
  isD17Invocation: boolean,
  env: Record<string, string | undefined>,
): string | null {
  const d17Names = ["D17_PRIVATE_KEY", "D17_EXECUTE", "D17_ROLE", "D17_STAGE"];
  if (!isD17Invocation) {
    if (d17Names.some((name) => Boolean(env[name]))) {
      throw new Error("D17 signer/stage environment requires multi-participant-check");
    }
    return null;
  }

  const forbidden = Object.keys(env).filter((name) =>
    name !== "D17_PRIVATE_KEY" && Boolean(env[name]) && (
      /PRIVATE_KEY|MNEMONIC|SEED_PHRASE/i.test(name) ||
      name.startsWith("D15_") || name.startsWith("LIVE_CHECK_")
    ),
  );
  if (forbidden.length) throw new Error("D17 requires an isolated single-role environment");
  const role = env.D17_ROLE ?? "none";
  if (!/^(none|deployer|node-[12]|participant-[1-5])$/.test(role)) {
    throw new Error("D17 role is invalid");
  }
  if (!env.D17_STAGE || !/^[a-z][a-z0-9-]*$/.test(env.D17_STAGE)) {
    throw new Error("D17 stage is required");
  }
  if (env.D17_EXECUTE !== undefined && env.D17_EXECUTE !== "1") {
    throw new Error("D17 execution flag is invalid");
  }
  const key = env.D17_PRIVATE_KEY ?? "";
  if (env.D17_EXECUTE !== "1") {
    if (key) throw new Error("D17 read-only invocation cannot load a signer");
    return "";
  }
  if (role === "none" || !/^(0x)?[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("D17 execution requires exactly one valid role signer");
  }
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  try {
    computeAddress(normalized);
  } catch {
    // Hardhat/ethers validation errors can include their input argument.
    throw new Error("D17 signer scalar is invalid");
  }
  return normalized;
}
