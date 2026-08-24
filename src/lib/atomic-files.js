import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const fileQueues = new Map();

export function serializeFile(file, task) {
  const key = path.resolve(file);
  const previous = fileQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  fileQueues.set(key, current);
  return current.finally(() => {
    if (fileQueues.get(key) === current) fileQueues.delete(key);
  });
}

export async function atomicWriteFile(file, contents, mode = 0o600) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    await fs.writeFile(tmp, contents, { mode });
    await fs.rename(tmp, file);
    await fs.chmod(file, mode);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
