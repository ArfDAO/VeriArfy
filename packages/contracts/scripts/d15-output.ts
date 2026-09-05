import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type RenameFile = (source: string, destination: string) => void;

type PublishOptions = {
  renameFile?: RenameFile;
  uniqueId?: string;
};

type OutputEntry = {
  target: string;
  temp: string;
  backup: string;
  originalMoved: boolean;
  published: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Publish the contract and web deployment files as one recoverable pair.
 * A failure before both renames complete restores both previous targets.
 */
export function publishD15OutputPair(
  targets: readonly [string, string],
  serialized: string,
  options: PublishOptions = {},
): void {
  if (targets[0] === targets[1]) {
    throw new Error("D15 output hedefleri farkli olmalidir");
  }
  const renameFile = options.renameFile ?? renameSync;
  const uniqueId = options.uniqueId ?? `${process.pid}-${Date.now()}`;
  const entries: OutputEntry[] = targets.map((target) => ({
    target,
    temp: `${target}.resume-${uniqueId}.tmp`,
    backup: `${target}.resume-${uniqueId}.bak`,
    originalMoved: false,
    published: false,
  }));
  let committed = false;

  try {
    for (const entry of entries) {
      mkdirSync(dirname(entry.target), { recursive: true });
      writeFileSync(entry.temp, serialized, { flag: "wx" });
    }
    for (const entry of entries) {
      if (existsSync(entry.target)) {
        renameFile(entry.target, entry.backup);
        entry.originalMoved = true;
      }
    }
    for (const entry of entries) {
      renameFile(entry.temp, entry.target);
      entry.published = true;
    }
    committed = true;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.published) removeIfPresent(entry.target);
        if (entry.originalMoved && existsSync(entry.backup)) {
          renameFile(entry.backup, entry.target);
          entry.originalMoved = false;
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.target}: ${errorText(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `D15 output yayimi basarisiz (${errorText(error)}); rollback basarisiz: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  } finally {
    for (const entry of entries) {
      try {
        removeIfPresent(entry.temp);
      } catch {
        // Temp cleanup failure does not change either published target.
      }
      if (committed) {
        try {
          removeIfPresent(entry.backup);
        } catch {
          // A leftover backup is safe; both target files are already committed.
        }
      }
    }
  }
}
