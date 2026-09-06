import { getBytes, keccak256 } from "ethers";

export type ImmutableReference = { start: number; length: number };

export function bytecodeHash(bytecode: string, label: string): string {
  if (typeof bytecode !== "string" || !/^0x[0-9a-fA-F]*$/.test(bytecode) || bytecode.length < 4) {
    throw new Error(`${label} bytecode gecersiz`);
  }
  return keccak256(getBytes(bytecode)).toLowerCase();
}

export function assertBytecodeHash(bytecode: string, expected: string, label: string): void {
  const actual = bytecodeHash(bytecode, label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(expected) || actual !== expected.toLowerCase()) {
    throw new Error(`${label} hash beklenen degerde degil`);
  }
}

function word(value: string | bigint, label: string): string {
  const hex = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64) throw new Error(`${label} immutable word gecersiz`);
  return hex.toLowerCase().padStart(64, "0");
}

/** Replace every build-info immutable reference with its constructor value. */
export function patchImmutableReferences(
  bytecodeObject: string,
  references: Record<string, ImmutableReference[]>,
  values: Record<string, string | bigint>,
): string {
  if (!/^[0-9a-fA-F]*$/.test(bytecodeObject) || bytecodeObject.length % 2 !== 0) {
    throw new Error("build-info deployed bytecode gecersiz");
  }
  let patched = bytecodeObject.toLowerCase();
  for (const [id, entries] of Object.entries(references)) {
    if (values[id] === undefined) throw new Error(`immutable ${id} degeri eksik`);
    const replacement = word(values[id], `immutable ${id}`);
    for (const entry of entries) {
      if (
        !Number.isInteger(entry.start) ||
        !Number.isInteger(entry.length) ||
        entry.start < 0 ||
        entry.length !== 32 ||
        (entry.start + entry.length) * 2 > patched.length
      ) {
        throw new Error(`immutable ${id} reference gecersiz`);
      }
      const start = entry.start * 2;
      const end = (entry.start + entry.length) * 2;
      patched = `${patched.slice(0, start)}${replacement.slice(0, entry.length * 2)}${patched.slice(end)}`;
    }
  }
  return `0x${patched}`;
}

export function patchedRuntimeHash(
  bytecodeObject: string,
  references: Record<string, ImmutableReference[]>,
  values: Record<string, string | bigint>,
): string {
  return bytecodeHash(patchImmutableReferences(bytecodeObject, references, values), "patched runtime");
}
