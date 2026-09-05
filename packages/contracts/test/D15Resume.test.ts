import { expect } from "chai";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifacts, ethers } from "hardhat";

import {
  assertD15ResumeBaselineState,
  assertResumeBoundaryNonce,
  assertResumeNonce,
  d15ResumeBoundaryState,
  loadD15ResumeManifest,
  parseD15ResumeManifest,
} from "../scripts/d15-resume-state";
import { assertBytecodeHash, bytecodeHash, patchedRuntimeHash } from "../scripts/d15-artifacts";
import { publishD15OutputPair } from "../scripts/d15-output";

describe("D15 partial-deploy resume predicates", () => {
  it("pins every completed creation to the deployer nonce and code manifest", () => {
    const manifest = loadD15ResumeManifest();
    expect(manifest.startNonce).to.equal(15);
    expect(manifest.completedNonces).to.deep.equal([...Array(15).keys()]);
    expect(manifest.created["0"].name).to.equal("Groth16Verifier");
    expect(manifest.resume.stakingAddress).to.equal("0xe03784E8911c46256808c881f37DEad3b90cbEF4");
    expect(manifest.resume.storageAddress).to.equal("0x5DbC770ed983Be52359B47D971598F09Aa4fD058");
  });

  it("fails closed on altered address, nonce, or code-hash facts", () => {
    const manifest = loadD15ResumeManifest();
    expect(() => parseD15ResumeManifest({ ...manifest, startNonce: 14 })).to.throw();
    expect(() =>
      parseD15ResumeManifest({
        ...manifest,
        created: {
          ...manifest.created,
          "0": {
            ...manifest.created["0"],
            address: manifest.created["1"].address,
          },
        },
      }),
    ).to.throw("CREATE adresi");
    expect(() => assertResumeNonce(15, 16, 15)).to.throw("nonce kilidi");
    expect(() => assertResumeNonce(15, 15, 15)).not.to.throw();
  });

  it("accepts only exact resumable transaction boundaries", () => {
    for (const boundary of [15, 18, 24]) {
      expect(assertResumeBoundaryNonce(boundary, boundary)).to.equal(boundary);
    }
    expect(() => assertResumeBoundaryNonce(14, 14)).to.throw("aralik disi");
    expect(() => assertResumeBoundaryNonce(25, 25)).to.throw("aralik disi");
    expect(() => assertResumeBoundaryNonce(18, 19)).to.throw("nonce kilidi");

    expect(d15ResumeBoundaryState(15)).to.deep.equal({
      metricsConfigured: false,
      queryGatewayConfigured: false,
      stakingDeployed: false,
      stakingPaymentsConfigured: false,
      stakingModuleConfigured: false,
      challengeConfigured: false,
      livenessConfigured: false,
      storageDeployed: false,
      storageAttestorConfigured: false,
    });
    expect(d15ResumeBoundaryState(18)).to.include({
      metricsConfigured: true,
      queryGatewayConfigured: true,
      stakingDeployed: true,
      stakingPaymentsConfigured: false,
    });
    expect(d15ResumeBoundaryState(24)).to.satisfy((state: Record<string, boolean>) =>
      Object.values(state).every(Boolean),
    );
  });

  it("requires the verified empty resume slots and exact protocol baseline", () => {
    const manifest = loadD15ResumeManifest();
    const protocol = {
      owner: manifest.deployer,
      threshold: 2n,
      minParticipants: 1n,
      authorizedNodeCount: 2n,
      authorizedNodes: [true, true],
      biomarkerModule: manifest.created["12"].address,
      queryGateway: "0x0000000000000000000000000000000000000000",
      stakingModule: "0x0000000000000000000000000000000000000000",
      challengePeriod: 0n,
      livenessTimeout: 0n,
      snpCount: 10n,
      rareSnpIndex: 0n,
      panelHash: manifest.expected.protocol.panelHash,
      panelUri: manifest.expected.protocol.panelUri,
      accreditedRoot: BigInt(manifest.expected.protocol.accreditedRoot),
    };
    const biomarkers = {
      owner: manifest.deployer,
      protocol: manifest.created["6"].address,
      metricCount: 0n,
      metricsHash: `0x${"00".repeat(32)}`,
      metricsUri: "",
      panelFrozen: false,
    };
    expect(() => assertD15ResumeBaselineState(protocol, biomarkers, manifest)).not.to.throw();
    expect(() =>
      assertD15ResumeBaselineState(
        { ...protocol, stakingModule: manifest.resume.stakingAddress },
        biomarkers,
        manifest,
      ),
    ).to.throw();
  });

  it("pins artifacts/build-info and matches locally deployed immutable runtimes", async () => {
    const manifest = loadD15ResumeManifest();
    const staking = await artifacts.readArtifact("VeriarfyStaking");
    const storage = await artifacts.readArtifact("VeriarfyStorage");
    assertBytecodeHash(staking.bytecode, manifest.resume.stakingCreationHash, "staking creation");
    assertBytecodeHash(staking.deployedBytecode, manifest.resume.stakingTemplateHash, "staking template");
    assertBytecodeHash(storage.bytecode, manifest.resume.storageCreationHash, "storage creation");
    assertBytecodeHash(storage.deployedBytecode, manifest.resume.storageTemplateHash, "storage template");
    expect(() =>
      assertBytecodeHash(`${staking.bytecode}00`, manifest.resume.stakingCreationHash, "altered staking"),
    ).to.throw("hash beklenen degerde degil");

    const stakingBuild = await artifacts.getBuildInfo(`${staking.sourceName}:${staking.contractName}`);
    const storageBuild = await artifacts.getBuildInfo(`${storage.sourceName}:${storage.contractName}`);
    expect(stakingBuild).not.to.equal(undefined);
    expect(storageBuild).not.to.equal(undefined);
    const stakingOutput = stakingBuild!.output.contracts[staking.sourceName][staking.contractName].evm.deployedBytecode;
    const storageOutput = storageBuild!.output.contracts[storage.sourceName][storage.contractName].evm.deployedBytecode;
    assertBytecodeHash(`0x${stakingOutput.object}`, manifest.resume.stakingTemplateHash, "staking build-info");
    assertBytecodeHash(`0x${storageOutput.object}`, manifest.resume.storageTemplateHash, "storage build-info");

    const stakingReferences = stakingOutput.immutableReferences;
    const storageReferences = storageOutput.immutableReferences;
    if (!stakingReferences || !storageReferences) {
      throw new Error("test build-info immutableReferences eksik");
    }
    const stakingImmutableId = Object.keys(stakingReferences);
    const storageImmutableId = Object.keys(storageReferences);
    expect(stakingImmutableId).to.have.length(1);
    expect(storageImmutableId).to.have.length(1);
    const [owner, protocol] = await ethers.getSigners();
    const stakingContract = await (
      await ethers.getContractFactory("VeriarfyStaking")
    ).deploy(
      owner.address,
      protocol.address,
      BigInt(manifest.resume.baseStakeWei),
      BigInt(manifest.resume.valueThreshold),
    );
    await stakingContract.waitForDeployment();
    const storageContract = await (
      await ethers.getContractFactory("VeriarfyStorage")
    ).deploy(owner.address, BigInt(manifest.resume.filecoinGenesis));
    await storageContract.waitForDeployment();

    const expectedStakingHash = patchedRuntimeHash(stakingOutput.object, stakingReferences, {
      [stakingImmutableId[0]]: protocol.address,
    });
    const expectedStorageHash = patchedRuntimeHash(storageOutput.object, storageReferences, {
      [storageImmutableId[0]]: BigInt(manifest.resume.filecoinGenesis),
    });
    expect(
      bytecodeHash(await ethers.provider.getCode(await stakingContract.getAddress()), "local staking runtime"),
    ).to.equal(expectedStakingHash);
    expect(
      bytecodeHash(await ethers.provider.getCode(await storageContract.getAddress()), "local storage runtime"),
    ).to.equal(expectedStorageHash);
  });

  it("restores both deployment outputs if the second publish rename fails", () => {
    const root = mkdtempSync(join(tmpdir(), "veriarfy-d15-output-"));
    const contractPath = join(root, "contracts.json");
    const webPath = join(root, "web.json");
    try {
      writeFileSync(contractPath, "old-contracts\n");
      writeFileSync(webPath, "old-web\n");
      expect(() =>
        publishD15OutputPair([contractPath, webPath], "new\n", {
          uniqueId: "rollback-test",
          renameFile: (source, destination) => {
            if (source.endsWith(".tmp") && destination === webPath) {
              throw new Error("injected second publish failure");
            }
            renameSync(source, destination);
          },
        }),
      ).to.throw("injected second publish failure");
      expect(readFileSync(contractPath, "utf8")).to.equal("old-contracts\n");
      expect(readFileSync(webPath, "utf8")).to.equal("old-web\n");
      expect(readdirSync(root).sort()).to.deep.equal(["contracts.json", "web.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
