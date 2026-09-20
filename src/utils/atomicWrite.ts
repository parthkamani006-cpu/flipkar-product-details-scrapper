import fs from "node:fs";
import path from "node:path";

/**
 * Write a file atomically: serialise to a sibling temp file, fsync it, then
 * rename over the target. Rename is atomic on both NTFS and POSIX, so a crash
 * mid-write can never leave a half-written (unparseable) file behind — the
 * reader either sees the previous version or the new one.
 *
 * This is what makes the checkpoint trustworthy after a hard kill.
 */
export function atomicWriteFileSync(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/** Atomically write a value as pretty-printed JSON. */
export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(value, null, 2));
}
