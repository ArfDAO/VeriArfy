import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { fullProveIsolated } from "../scripts/isolated-proof";

const childProcess = require("node:child_process") as typeof import("node:child_process");
const BUILD = join(__dirname, "..", "..", "circuits", "build");
const IDENTITY_WASM = join(BUILD, "researcher_identity_js", "researcher_identity.wasm");
const IDENTITY_ZKEY = join(BUILD, "researcher_identity_final.zkey");
const IDENTITY_VKEY = join(BUILD, "researcher_identity_verification_key.json");
const PROVENANCE_WASM = join(BUILD, "data_provenance_js", "data_provenance.wasm");
const PROVENANCE_ZKEY = join(BUILD, "data_provenance_final.zkey");
const PROVENANCE_VKEY = join(BUILD, "data_provenance_verification_key.json");

const VALID_OUTPUT = JSON.stringify({
  proof: {
    protocol: "groth16",
    curve: "bn128",
    pi_a: ["1", "2", "1"],
    pi_b: [["1", "2"], ["3", "4"], ["5", "6"]],
    pi_c: ["7", "8", "1"],
  },
  publicSignals: ["9"],
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, "SIGTERM");
    });
    return true;
  }
}

type MockMode = "empty" | "malformed" | "nonzero" | "timeout" | "output-bound" | "valid";
type MockCapture = { args: string[]; options: any; input: string; child: FakeChild };

function loadUntyped(moduleName: string): Promise<any> {
  return import(moduleName);
}

async function withMockChild<T>(mode: MockMode, action: (capture: MockCapture) => Promise<T>): Promise<T> {
  const capture = {} as MockCapture;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = ((...args: any[]) => {
    const child = new FakeChild();
    capture.args = args[1];
    capture.options = args[2];
    capture.child = child;
    child.stdin.on("data", (chunk) => {
      capture.input = (capture.input ?? "") + chunk.toString("utf8");
    });
    queueMicrotask(() => {
      if (mode === "timeout" || mode === "output-bound") return;
      if (mode === "malformed") child.stdout.end('{"proof":');
      else if (mode === "valid" || mode === "nonzero") child.stdout.end(VALID_OUTPUT);
      else child.stdout.end();
      child.stderr.end();
      child.emit("close", mode === "nonzero" ? 7 : 0, null);
    });
    if (mode === "output-bound") {
      queueMicrotask(() => child.stdout.end(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78)));
    }
    return child as any;
  }) as typeof childProcess.spawn;
  try {
    return await action(capture);
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

async function expectReject(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof Error && pattern.test(error.message));
}

async function verifySingleThread(snarkjs: any, vkey: any, result: any): Promise<boolean> {
  const ffjavascript: any = require("ffjavascript");
  const previous = (globalThis as any).curve_bn128;
  const curve = await ffjavascript.buildBn128(true);
  (globalThis as any).curve_bn128 = curve;
  try {
    return await snarkjs.groth16.verify(vkey, result.publicSignals, result.proof);
  } finally {
    (globalThis as any).curve_bn128 = previous;
  }
}

describe("izole Groth16 kanit uretimi", function () {
  this.timeout(60 * 1000);

  it("kimlik kanitini alt proseste uretir ve dogrular", async () => {
    for (const path of [IDENTITY_WASM, IDENTITY_ZKEY, IDENTITY_VKEY]) {
      assert.equal(existsSync(path), true, `eksik devre artefakti: ${path}`);
    }
    const circuits: any = await loadUntyped("@veriarfy/circuits");
    const snarkjs: any = await loadUntyped("snarkjs");
    const identity = circuits.createIdentity();
    const tree = new circuits.IdentityTree();
    tree.insert(identity.commitment);
    const input = circuits.buildCircuitInput({
      identity,
      tree,
      externalNullifier: 20260814n,
      signerAddress: "0x0000000000000000000000000000000000000123",
    });

    const result = await fullProveIsolated(input, IDENTITY_WASM, IDENTITY_ZKEY);
    const vkey = JSON.parse(readFileSync(IDENTITY_VKEY, "utf8"));
    assert.equal(await verifySingleThread(snarkjs, vkey, result), true);
  });

  it("sentetik provenance kanitini alt proseste uretir ve dogrular", async () => {
    for (const path of [PROVENANCE_WASM, PROVENANCE_ZKEY, PROVENANCE_VKEY]) {
      assert.equal(existsSync(path), true, `eksik devre artefakti: ${path}`);
    }
    const provenance: any = await loadUntyped("@veriarfy/circuits/provenance");
    const snarkjs: any = await loadUntyped("snarkjs");
    const input = provenance.buildSelfProvenanceInput({
      dosages: Array.from({ length: provenance.PANEL_SIZE }, (_, index) => [0, 1, 2, 1, 0, 2][index % 6]),
      salt: 123n,
      externalNullifier: 20260814n,
      cidDigest: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      signerAddress: 0x123n,
    });

    const result = await fullProveIsolated(input, PROVENANCE_WASM, PROVENANCE_ZKEY);
    const vkey = JSON.parse(readFileSync(PROVENANCE_VKEY, "utf8"));
    assert.equal(await verifySingleThread(snarkjs, vkey, result), true);
  });

  it("bos, bozuk, kesilmis ve basarisiz IPC ciktilarini reddeder", async () => {
    await withMockChild("empty", async () =>
      expectReject(fullProveIsolated({}, IDENTITY_WASM, IDENTITY_ZKEY), /empty output/));
    await withMockChild("malformed", async () =>
      expectReject(fullProveIsolated({}, IDENTITY_WASM, IDENTITY_ZKEY), /malformed output/));
    await withMockChild("nonzero", async () =>
      expectReject(fullProveIsolated({}, IDENTITY_WASM, IDENTITY_ZKEY), /exited with code 7/));
  });

  it("zaman asimini ve cikti sinirini asan cocugu temizler", async () => {
    await withMockChild("timeout", async (capture) => {
      await expectReject(
        fullProveIsolated({}, IDENTITY_WASM, IDENTITY_ZKEY, { timeoutMs: 10 }),
        /timed out/,
      );
      assert.equal(capture.child.killed, true);
    });
    await withMockChild("output-bound", async (capture) => {
      await expectReject(fullProveIsolated({}, IDENTITY_WASM, IDENTITY_ZKEY), /output exceeds/);
      assert.equal(capture.child.killed, true);
    });
  });

  it("tanigi stdin'e yazar ve ozel ortam degiskenlerini cocuktan uzak tutar", async () => {
    const secret = "private-key-must-not-cross-process";
    const previous = process.env.DEPLOYER_PRIVATE_KEY;
    process.env.DEPLOYER_PRIVATE_KEY = secret;
    try {
      const witness = { secret: 123n, nested: [456n] };
      await withMockChild("valid", async (capture) => {
        const result = await fullProveIsolated(witness, IDENTITY_WASM, IDENTITY_ZKEY);
        assert.deepEqual(result.publicSignals, ["9"]);
        assert.equal(capture.input, '{"secret":"123","nested":["456"]}');
        assert.equal(capture.args.includes(secret), false);
        assert.equal(capture.options.env.DEPLOYER_PRIVATE_KEY, undefined);
        assert.equal(capture.options.env.NODE_OPTIONS, undefined);
        assert.equal(capture.options.windowsHide, true);
        assert.equal(capture.options.shell, false);
      });
    } finally {
      if (previous === undefined) delete process.env.DEPLOYER_PRIVATE_KEY;
      else process.env.DEPLOYER_PRIVATE_KEY = previous;
    }
  });
});
