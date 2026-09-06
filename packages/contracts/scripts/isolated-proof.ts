import { spawn } from "node:child_process";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const WORKER = join(__dirname, "proof-worker.cjs");

export type IsolatedProof = {
  proof: Record<string, unknown>;
  publicSignals: string[];
};

export type IsolatedProofOptions = {
  timeoutMs?: number;
};

function stringifyWitness(input: unknown): string {
  const json = JSON.stringify(input, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString(10) : value,
  );
  if (!json) throw new Error("proof input is not JSON serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("proof input exceeds the isolation limit");
  }
  return json;
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "Path", "PATH", "TEMP", "TMP", "USERPROFILE"]
    : ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function validateResult(value: unknown): IsolatedProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("proof worker returned a malformed result");
  }
  const result = value as { proof?: unknown; publicSignals?: unknown };
  if (!result.proof || typeof result.proof !== "object" || Array.isArray(result.proof)) {
    throw new Error("proof worker returned no proof");
  }
  if (!Array.isArray(result.publicSignals) || result.publicSignals.length === 0) {
    throw new Error("proof worker returned no public signals");
  }
  if (result.publicSignals.some((signal) => typeof signal !== "string" || !/^\d+$/.test(signal))) {
    throw new Error("proof worker returned malformed public signals");
  }
  const proof = result.proof as Record<string, unknown>;
  const decimal = (item: unknown): item is string => typeof item === "string" && /^\d+$/.test(item);
  const piA = proof.pi_a;
  const piB = proof.pi_b;
  const piC = proof.pi_c;
  const validPoint = (point: unknown, size: number): point is string[] =>
    Array.isArray(point) && point.length === size && point.every(decimal);
  if (
    proof.protocol !== "groth16" ||
    !validPoint(piA, 3) ||
    !Array.isArray(piB) ||
    piB.length !== 3 ||
    !piB.every((point) => validPoint(point, 2)) ||
    !validPoint(piC, 3)
  ) {
    throw new Error("proof worker returned malformed Groth16 proof");
  }
  return { proof, publicSignals: result.publicSignals as string[] };
}

function killChild(child: ReturnType<typeof spawn>): void {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } catch {
    // The close event still drains and reports the original failure.
  }
}

export function fullProveIsolated(
  input: unknown,
  wasmPath: string,
  zkeyPath: string,
  options: IsolatedProofOptions = {},
): Promise<IsolatedProof> {
  if (!isAbsolute(wasmPath) || !isAbsolute(zkeyPath)) {
    return Promise.reject(new Error("absolute wasm and zkey paths are required"));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("proof timeout must be positive"));
  }

  let witness: string;
  try {
    witness = stringifyWitness(input);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      resolvePath(process.execPath),
      ["--max-old-space-size=512", WORKER, wasmPath, zkeyPath],
      {
        env: isolatedEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      },
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const onParentExit = () => killChild(child);
    process.once("exit", onParentExit);

    const fail = (message: string) => {
      if (!failure) failure = new Error(message);
      killChild(child);
    };
    const timer = setTimeout(() => fail(`proof worker timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail("proof worker output exceeds the isolation limit");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) fail("proof worker output exceeds the isolation limit");
    });
    child.once("error", () => fail("proof worker could not start"));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("exit", onParentExit);
      if (settled) return;
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      if (signal) {
        reject(new Error(`proof worker terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`proof worker exited with code ${code}`));
        return;
      }
      const raw = Buffer.concat(stdout).toString("utf8").trim();
      if (!raw) {
        reject(new Error("proof worker returned empty output"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new Error("proof worker returned malformed output"));
        return;
      }
      try {
        resolve(validateResult(parsed));
      } catch {
        reject(new Error("proof worker returned malformed result"));
      }
    });

    child.stdin.once("error", () => fail("proof worker stdin failed"));
    child.stdin.end(witness);
  });
}
