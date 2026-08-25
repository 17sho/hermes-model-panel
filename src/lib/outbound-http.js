import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch, Headers } from "undici";

const ALWAYS_BLOCKED = new Set([
  "metadata",
  "link-local",
  "unspecified",
  "multicast",
]);

function ipv4Number(value) {
  if (!net.isIPv4(value)) return null;
  return value.split(".").reduce((out, part) => (out << 8n) | BigInt(part), 0n);
}

function expandIpv6(input) {
  let value = input.toLowerCase().split("%", 1)[0];
  const mapped = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const n = ipv4Number(mapped[2]);
    if (n === null) return null;
    value = `${mapped[1]}${Number((n >> 16n) & 0xffffn).toString(16)}:${Number(n & 0xffffn).toString(16)}`;
  }
  if (!net.isIPv6(value)) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((x) =>
    Number.parseInt(x || "0", 16),
  );
}

export function classifyAddress(address) {
  const value = String(address || "")
    .toLowerCase()
    .split("%", 1)[0];
  const v4 = ipv4Number(value);
  if (v4 !== null) {
    const a = Number((v4 >> 24n) & 255n);
    const b = Number((v4 >> 16n) & 255n);
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254)
      return value === "169.254.169.254" ? "metadata" : "link-local";
    if (a >= 224) return a <= 239 ? "multicast" : "reserved";
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return "private";
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    return "public";
  }
  const groups = expandIpv6(value);
  if (!groups) return "invalid";
  if (groups.every((x) => x === 0)) return "unspecified";
  if (groups.slice(0, 7).every((x) => x === 0) && groups[7] === 1)
    return "loopback";
  if (
    groups[0] === 0xfe80 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 0xa9fe
  )
    return "metadata";
  if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((groups[0] & 0xfe00) === 0xfc00) return "ula";
  if ((groups[0] & 0xff00) === 0xff00) return "multicast";
  if (groups.slice(0, 5).every((x) => x === 0) && groups[5] === 0xffff) {
    return classifyAddress(
      `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`,
    );
  }
  return "public";
}

export function isAddressAllowed(address, { allowPrivate = false } = {}) {
  const kind = classifyAddress(address);
  if (ALWAYS_BLOCKED.has(kind) || kind === "invalid" || kind === "reserved")
    return false;
  if (["private", "cgnat", "ula"].includes(kind)) return allowPrivate;
  return kind === "public" || kind === "loopback";
}

export async function validateOutboundUrl(input, options = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Provider URL 无效");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Provider URL 仅支持 HTTP(S)");
  if (url.username || url.password)
    throw new Error("Provider URL 不允许包含凭据");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolver = options.resolver || dns.lookup;
  let records;
  if (net.isIP(hostname))
    records = [{ address: hostname, family: net.isIP(hostname) }];
  else {
    try {
      records = await resolver(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Provider URL DNS 解析失败");
    }
  }
  if (!records?.length) throw new Error("Provider URL DNS 解析失败");
  const allowPrivate =
    options.allowPrivate ?? process.env.ALLOW_PRIVATE_PROVIDER_URLS === "1";
  for (const record of records) {
    if (!isAddressAllowed(record.address, { allowPrivate }))
      throw new Error(
        `Provider URL 指向不允许的网络地址（${classifyAddress(record.address)}）`,
      );
  }
  return {
    url,
    records: records.map((r) => ({
      address: r.address,
      family: Number(r.family),
    })),
  };
}

export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("并发限制必须为正整数");
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }
  async run(task) {
    if (this.active >= this.limit)
      await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function redirectMethod(status, method) {
  if (status === 303 && method !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
}

export async function safeOutboundFetch(input, init = {}, options = {}) {
  const maxRedirects = options.maxRedirects ?? 3;
  const fetchImpl = options.fetchImpl || undiciFetch;
  let current = String(input);
  let requestInit = { ...init, redirect: "manual" };
  for (let redirects = 0; ; redirects += 1) {
    const validated = await validateOutboundUrl(current, options);
    let dispatcher = null;
    if (!options.fetchImpl) {
      const records = validated.records;
      dispatcher = new Agent({
        connect: {
          lookup(_hostname, lookupOptions, callback) {
            const selected = records.map((r) => ({ ...r }));
            if (lookupOptions?.all) callback(null, selected);
            else callback(null, selected[0].address, selected[0].family);
          },
        },
      });
    }
    let response;
    try {
      response = await fetchImpl(validated.url, {
        ...requestInit,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (dispatcher) await dispatcher.close();
      throw error;
    }
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return {
        response,
        close: () => dispatcher?.close() || Promise.resolve(),
      };
    }
    await response.body?.cancel().catch(() => {});
    if (dispatcher) await dispatcher.close();
    if (redirects >= maxRedirects)
      throw new Error("Provider URL 重定向次数过多");
    const nextUrl = new URL(location, validated.url);
    current = nextUrl.href;
    const method = redirectMethod(
      response.status,
      String(requestInit.method || "GET").toUpperCase(),
    );
    requestInit = { ...requestInit, method };
    if (nextUrl.origin !== validated.url.origin) {
      const headers = new Headers(requestInit.headers);
      headers.delete("authorization");
      headers.delete("proxy-authorization");
      headers.delete("cookie");
      headers.delete("x-api-key");
      requestInit.headers = headers;
    }
    if (method === "GET" || method === "HEAD") {
      delete requestInit.body;
      const headers = new Headers(requestInit.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      requestInit.headers = headers;
    }
  }
}
