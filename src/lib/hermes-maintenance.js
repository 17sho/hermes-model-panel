import fs from "node:fs/promises";
import path from "node:path";

const VERSION_RE = /Hermes Agent v([^\s]+)(?:\s+\(([^)]+)\))?/i;
const SECRET_RE =
  /(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)(\S+)/gi;

export function redactMaintenanceOutput(value = "") {
  return String(value)
    .replace(SECRET_RE, "$1$2[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .slice(0, 120000);
}

export function parseHermesVersionOutput(output = "") {
  const text = String(output);
  const match = text.match(VERSION_RE);
  const field = (label) =>
    text.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1]?.trim() || "";
  return {
    version: match?.[1] || "",
    build: match?.[2] || "",
    install_directory: field("Install directory"),
    install_method: field("Install method"),
    python: field("Python"),
    raw: redactMaintenanceOutput(text),
  };
}

export function parseHermesUpdateCheck(output = "", currentVersion = "") {
  const text = redactMaintenanceOutput(output);
  const latest =
    text.match(
      /(?:latest|new(?:est)?|available)[^\n]*?v?(\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?)/i,
    )?.[1] || "";
  const noUpdate =
    /(already (?:up[ -]to[ -]date|latest)|no updates? available|up to date)/i.test(
      text,
    );
  const updateAvailable =
    !noUpdate &&
    (/(update available|new version|behind\s+(?:origin|upstream))/i.test(
      text,
    ) ||
      Boolean(latest && latest !== currentVersion));
  return {
    checked: true,
    latest_version: latest || currentVersion,
    update_available: updateAvailable,
    message: text.trim() || "检查完成",
  };
}

export async function readMaintenanceStatus(statusPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statusPath, "utf8"));
    return {
      state: "idle",
      message: "尚未执行维护任务",
      ...parsed,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-200) : [],
    };
  } catch {
    return { state: "idle", message: "尚未执行维护任务", logs: [] };
  }
}

export function resolveHermesBinary(value = "hermes") {
  const candidate = String(value || "hermes").trim();
  if (candidate === "hermes") return candidate;
  if (!path.isAbsolute(candidate) || !/^\/[A-Za-z0-9_./+-]+$/.test(candidate))
    throw new Error("Hermes 可执行文件路径无效");
  return path.normalize(candidate);
}
