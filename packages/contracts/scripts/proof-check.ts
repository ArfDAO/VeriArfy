import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ethers, fhevm, network } from "hardhat";
import { loadD15Profile } from "./d15-profile";
import { fullProveIsolated } from "./isolated-proof";

/** Synthetic proofs after real FHE CLI initialization; no signer or transactions. */
async function main() {
  const profile = loadD15Profile();
  if (
    network.name !== profile.network ||
    (await ethers.provider.getNetwork()).chainId !== BigInt(profile.chainId) ||
    (await ethers.getSigners()).length !== 0
  ) {
    throw new Error("proof-check requires Sepolia with no signers");
  }
  console.log("FHE CLI initialization...");
  await fhevm.initializeCLIApi();
  console.log("FHE CLI ready; importing provenance...");
  const provenance: any = require("@veriarfy/circuits/provenance");
  console.log("Provenance imported; importing identity...");
  const circuits: any = require("@veriarfy/circuits");
  console.log("Identity imported; building development registry...");
  await provenance.developmentRegistry();
  console.log("Development registry ready");
  const build = join(__dirname, "..", "..", "circuits", "build");
  const deployment = JSON.parse(readFileSync(
    join(__dirname, "..", "deployments", "sepolia.json"), "utf8",
  ));
  if (deployment.chainId !== profile.chainId || deployment.network !== profile.network) {
    throw new Error("proof-check deployment network mismatch");
  }
  const rejected: string[] = [];
  async function verify(name: string, result: Awaited<ReturnType<typeof fullProveIsolated>>) {
    const linkedAddress = name === "DataProvenanceVerifier"
      ? await (await ethers.getContractAt("VeriarfyProtocol", deployment.contracts.VeriarfyProtocol)).provenanceVerifier()
      : await (await ethers.getContractAt("VeriArfyRegistry", deployment.contracts.VeriArfyRegistry)).verifier();
    if (ethers.getAddress(linkedAddress) !== ethers.getAddress(deployment.contracts[name])) {
      throw new Error(`${name} deployment address differs from the linked verifier`);
    }
    const verifier = await ethers.getContractAt(name, linkedAddress);
    const { a, b, c } = circuits.toSolidityCalldata(result.proof);
    if (!(await verifier.verifyProof.staticCall(a, b, c, result.publicSignals))) {
      rejected.push(name);
      console.error(`${name} rejected proof (eth_call); check proving key / deployed verifier compatibility`);
      return false;
    }
    return true;
  }
  const input = provenance.buildSelfProvenanceInput({
    dosages: Array.from({ length: provenance.PANEL_SIZE }, (_, i) => [0, 1, 2, 1, 0, 2][i % 6]),
    salt: 123n,
    externalNullifier: 20260814n,
    cidDigest: ethers.keccak256(ethers.toUtf8Bytes("veriarfy-proof-check")),
    signerAddress: profile.deployer,
  });
  console.log("Isolated provenance proof...");
  const result = await fullProveIsolated(input,
    join(build, "data_provenance_js", "data_provenance.wasm"),
    join(build, "data_provenance_final.zkey"));
  const provenanceValid = await verify("DataProvenanceVerifier", result);
  console.log(`Provenance: ${result.publicSignals.length} signals, verified=${provenanceValid}`);
  const identity = circuits.createIdentity();
  const tree = new circuits.IdentityTree();
  tree.insert(identity.commitment);
  console.log("Isolated identity proof...");
  const idResult = await fullProveIsolated(circuits.buildCircuitInput({
    identity, tree, externalNullifier: 20260814n, signerAddress: profile.deployer,
  }), join(build, "researcher_identity_js", "researcher_identity.wasm"),
  join(build, "researcher_identity_final.zkey"));
  const identityValid = await verify("Groth16Verifier", idResult);
  console.log(`Identity: ${idResult.publicSignals.length} signals, verified=${identityValid}`);
  if (rejected.length) throw new Error(`proof-check failed: ${rejected.join(", ")}`);
  console.log("PROOF_CHECK_OK: no transactions sent");
}

// Keep a pending import/proof from looking like a successful run on Node 20.
const deadline = setTimeout(() => {
  console.error("proof-check timed out before completion");
  process.exit(1);
}, 180_000);
main().then(() => clearTimeout(deadline)).catch((error) => {
  clearTimeout(deadline);
  console.error(error);
  process.exitCode = 1;
});
