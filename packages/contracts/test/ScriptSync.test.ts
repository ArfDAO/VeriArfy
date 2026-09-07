import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { Interface } from "ethers";
import { artifacts } from "hardhat";
import ts from "typescript";

type ScriptCall = {
  script: string;
  contractName: string;
  member: string;
  argumentCount: number;
  kind: "constructor" | "function";
  line: number;
  column: number;
};

type ScriptAnalysis = {
  calls: ScriptCall[];
  contractNames: Set<string>;
};

type AbiMismatch = ScriptCall & {
  available: string[];
};

const SCRIPT_FILES = ["deploy.ts", "live-check.ts"] as const;

// These belong to the ethers contract wrapper rather than to Solidity ABI.
const CONTRACT_OBJECT_METHODS = new Set([
  "addListener",
  "connect",
  "deploymentTransaction",
  "getAddress",
  "getDeployedCode",
  "getEvent",
  "getFunction",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "queryFilter",
  "removeAllListeners",
  "removeListener",
  "waitForDeployment",
]);

// ethers v6 exposes these operations on a contract function object. The ABI
// member is the property immediately before the operation.
const CONTRACT_FUNCTION_OPERATIONS = new Set([
  "estimateGas",
  "populateTransaction",
  "send",
  "staticCall",
  "staticCallResult",
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function memberAccess(
  expression: ts.Expression,
): { receiver: ts.Expression; member: string } | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return { receiver: current.expression, member: current.name.text };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteral(current.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
  ) {
    return { receiver: current.expression, member: current.argumentExpression.text };
  }
  return null;
}

function hardhatContractName(call: ts.CallExpression, helper: string): string | null {
  const access = memberAccess(call.expression);
  const receiver = access ? unwrapExpression(access.receiver) : null;
  if (
    !access ||
    access.member !== helper ||
    !receiver ||
    !ts.isIdentifier(receiver) ||
    receiver.text !== "ethers"
  ) {
    return null;
  }

  const firstArgument = call.arguments[0];
  if (
    firstArgument &&
    (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))
  ) {
    return firstArgument.text;
  }
  return null;
}

function bindConsistently(
  bindings: Map<string, string>,
  variable: string,
  contractName: string,
  script: string,
): void {
  const previous = bindings.get(variable);
  if (previous && previous !== contractName) {
    throw new Error(
      `${script}: ${variable} hem ${previous} hem ${contractName} kontratina baglanmis`,
    );
  }
  bindings.set(variable, contractName);
}

function visit(sourceFile: ts.SourceFile, callback: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

function analyzeScript(source: string, script: string): ScriptAnalysis {
  const sourceFile = ts.createSourceFile(script, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const factories = new Map<string, string>();
  const contracts = new Map<string, string>();

  // First pass: bind getContractFactory results. Deployments can then be
  // resolved even if they are nested in a conditional block.
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer
    ) {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (!ts.isCallExpression(initializer)) return;
    const contractName = hardhatContractName(initializer, "getContractFactory");
    if (contractName) bindConsistently(factories, node.name.text, contractName, script);
  });

  // Second pass: bind getContractAt results and instances returned by a known
  // factory's deploy call.
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer
    ) {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (!ts.isCallExpression(initializer)) return;

    const attachedContract = hardhatContractName(initializer, "getContractAt");
    if (attachedContract) {
      bindConsistently(contracts, node.name.text, attachedContract, script);
      return;
    }

    const access = memberAccess(initializer.expression);
    const receiver = access ? unwrapExpression(access.receiver) : null;
    if (
      access?.member === "deploy" &&
      receiver &&
      ts.isIdentifier(receiver) &&
      factories.has(receiver.text)
    ) {
      bindConsistently(contracts, node.name.text, factories.get(receiver.text)!, script);
    }
  });

  const resolveContract = (expression: ts.Expression): string | null => {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return contracts.get(current.text) ?? null;

    // Preserve the contract identity through `contract.connect(signer)`.
    if (ts.isCallExpression(current)) {
      const access = memberAccess(current.expression);
      if (access?.member === "connect") return resolveContract(access.receiver);
    }
    return null;
  };

  const calls: ScriptCall[] = [];
  const recordCall = (
    call: ts.CallExpression,
    contractName: string,
    member: string,
    kind: ScriptCall["kind"],
  ): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
    calls.push({
      script,
      contractName,
      member,
      argumentCount: call.arguments.length,
      kind,
      line: position.line + 1,
      column: position.character + 1,
    });
  };

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const access = memberAccess(node.expression);
    if (!access) return;

    const factoryReceiver = unwrapExpression(access.receiver);
    if (
      access.member === "deploy" &&
      ts.isIdentifier(factoryReceiver) &&
      factories.has(factoryReceiver.text)
    ) {
      recordCall(node, factories.get(factoryReceiver.text)!, "constructor", "constructor");
      return;
    }

    const directContract = resolveContract(access.receiver);
    if (directContract) {
      if (!CONTRACT_OBJECT_METHODS.has(access.member)) {
        recordCall(node, directContract, access.member, "function");
      }
      return;
    }

    if (!CONTRACT_FUNCTION_OPERATIONS.has(access.member)) return;
    const functionAccess = memberAccess(access.receiver);
    if (!functionAccess) return;
    const functionContract = resolveContract(functionAccess.receiver);
    if (functionContract) {
      recordCall(node, functionContract, functionAccess.member, "function");
    }
  });

  return {
    calls,
    contractNames: new Set([...factories.values(), ...contracts.values()]),
  };
}

async function findAbiMismatches(calls: ScriptCall[]): Promise<AbiMismatch[]> {
  const interfaces = new Map<string, Interface>();
  const mismatches: AbiMismatch[] = [];

  for (const call of calls) {
    let iface = interfaces.get(call.contractName);
    if (!iface) {
      const artifact = await artifacts.readArtifact(call.contractName);
      iface = new Interface(artifact.abi);
      interfaces.set(call.contractName, iface);
    }

    if (call.kind === "constructor") {
      if (iface.deploy.inputs.length !== call.argumentCount) {
        mismatches.push({
          ...call,
          available: [`constructor(${iface.deploy.inputs.map((input) => input.type).join(",")})`],
        });
      }
      continue;
    }

    const candidates: string[] = [];
    const matchingArities: number[] = [];
    iface.forEachFunction((fragment) => {
      if (fragment.name !== call.member) return;
      candidates.push(fragment.format("sighash"));
      matchingArities.push(fragment.inputs.length);
    });
    if (!matchingArities.includes(call.argumentCount)) {
      mismatches.push({ ...call, available: candidates });
    }
  }

  return mismatches;
}

function mismatchMessage(mismatches: AbiMismatch[]): string {
  return mismatches
    .map((mismatch) => {
      const available =
        mismatch.available.length > 0 ? mismatch.available.join(" | ") : "ABI'de bu ad yok";
      return (
        `${mismatch.script}:${mismatch.line}:${mismatch.column} ` +
        `${mismatch.contractName}.${mismatch.member}(${mismatch.argumentCount} arguman); ` +
        `mevcut: ${available}`
      );
    })
    .join("\n");
}

function readScript(script: (typeof SCRIPT_FILES)[number]): string {
  return readFileSync(join(__dirname, "..", "scripts", script), "utf8");
}

describe("Script ABI senkronizasyonu", () => {
  it("deploy ve live-check kontrat cagrilarini statik olarak bulur", () => {
    const deploy = analyzeScript(readScript("deploy.ts"), "deploy.ts");
    const live = analyzeScript(readScript("live-check.ts"), "live-check.ts");
    const deployCalls = deploy.calls.map(
      (call) => `${call.contractName}.${call.member}/${call.argumentCount}`,
    );
    const liveCalls = live.calls.map(
      (call) => `${call.contractName}.${call.member}/${call.argumentCount}`,
    );

    expect(deployCalls).to.include("VeriarfyProtocol.constructor/5");
    expect(deployCalls).to.include("VeriarfyProtocol.configurePanel/4");
    expect(deployCalls).to.include("VeriarfyStorage.setAttestor/1");
    expect(liveCalls).to.include("VeriarfyProtocol.enroll/2");
    expect(liveCalls).to.include("Groth16Verifier.verifyProof/4");
    expect(liveCalls).to.include("VeriarfyPayments.openQuery/1");
    expect(deploy.contractNames.size).to.be.greaterThan(0);
    expect(live.contractNames.size).to.be.greaterThan(0);
  });

  it("scriptteki constructor ve fonksiyon cagrilari derlenmis ABI ile uyusur", async () => {
    const calls = SCRIPT_FILES.flatMap((script) =>
      analyzeScript(readScript(script), script).calls,
    );
    const mismatches = await findAbiMismatches(calls);

    expect(mismatches, mismatchMessage(mismatches)).to.deep.equal([]);
  });

  it("scriptte bir kontrat fonksiyonu yeniden adlandirilirsa kirmizi olur", async () => {
    const original = readScript("live-check.ts");
    const mutated = original.replace(
      "payments.openQuery(queryType as LiveCheckQueryType)",
      "payments.openQueryRenamed(queryType as LiveCheckQueryType)",
    );
    expect(mutated).to.not.equal(original);

    const mismatches = await findAbiMismatches(
      analyzeScript(mutated, "live-check.renamed.ts").calls,
    );
    expect(
      mismatches.some(
        (mismatch) =>
          mismatch.contractName === "VeriarfyPayments" &&
          mismatch.member === "openQueryRenamed",
      ),
      mismatchMessage(mismatches),
    ).to.equal(true);
  });
});
