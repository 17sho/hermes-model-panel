import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReadableStream } from "node:stream/web";

import { atomicWriteFile, serializeFile } from "../src/lib/atomic-files.js";
import { publicError, safeEqual } from "../src/lib/errors.js";
import {
  isPrivateAddress,
  mapConcurrent,
  readResponseText,
} from "../src/lib/http-safety.js";
import { createRequireAuth } from "../src/middleware/auth.js";
import { securityHeadersAndOrigin } from "../src/middleware/csrf.js";

test("atomic file writes serialize updates and preserve restrictive mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hmp-atomic-"));
  const file = path.join(directory, "value.json");
  let value = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      serializeFile(file, async () => {
        value += 1;
        await atomicWriteFile(file, String(value));
      }),
    ),
  );
  assert.equal(await fs.readFile(file, "utf8"), "12");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(directory, { recursive: true, force: true });
});

test("error helpers compare safely and redact paths", () => {
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "other"), false);
  assert.doesNotMatch(
    publicError(new Error("/private/path/file failed")),
    /private/,
  );
});

test("auth middleware keeps unauthorized and CSRF semantics", async () => {
  const middleware = createRequireAuth({
    authDisabled: () => false,
    cliAuthHeader: "x-cli",
    cookieName: "session",
    safeEqual,
    tokenPayload: (token) => (token === "valid" ? { csrf: "token" } : null),
    trustedProxyAuthHeader: "x-proxy",
    trustProxyAuth: false,
    validTimedHmac: () => false,
  });
  const makeContext = (method = "GET", cookie = "") => ({
    method,
    path: "/api/state",
    req: { socket: { remoteAddress: "203.0.113.2" } },
    cookies: { get: () => cookie },
    get: (name) => (name === "x-csrf-token" ? "" : ""),
  });
  const unauthorized = makeContext();
  await middleware(unauthorized, () => assert.fail("must not continue"));
  assert.equal(unauthorized.status, 401);
  const csrf = makeContext("POST", "valid");
  await middleware(csrf, () => assert.fail("must not continue"));
  assert.equal(csrf.status, 403);
});

test("origin middleware rejects a cross-site mutation", async () => {
  const headers = new Map();
  const ctx = {
    path: "/api/state",
    method: "POST",
    host: "panel.test",
    protocol: "https",
    set: (key, value) => headers.set(key, value),
    get: (key) => (key === "origin" ? "https://evil.test" : ""),
  };
  await securityHeadersAndOrigin()(ctx, () => assert.fail("must not continue"));
  assert.equal(ctx.status, 403);
  assert.equal(headers.get("X-Frame-Options"), "DENY");
});

test("origin middleware uses canonical HTTPS origin behind an HTTP proxy", async () => {
  const middleware = securityHeadersAndOrigin({
    publicOrigin: "https://panel.test",
  });
  const makeContext = (origin) => ({
    path: "/api/login",
    method: "POST",
    host: "127.0.0.1:3010",
    protocol: "http",
    set: () => {},
    get: (key) => (key === "origin" ? origin : ""),
  });
  const allowed = makeContext("https://panel.test");
  let continued = false;
  await middleware(allowed, () => {
    continued = true;
  });
  assert.equal(continued, true);
  const rejected = makeContext("http://panel.test");
  await middleware(rejected, () => assert.fail("must not continue"));
  assert.equal(rejected.status, 403);
});

test("bounded upstream reads abort oversized streaming bodies", async () => {
  const makeResponse = (text) => {
    const bytes = Buffer.from(text);
    return {
      headers: new Map(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
  await assert.rejects(
    () => readResponseText(makeResponse("x".repeat(32)), 16),
    /大小限制/,
  );
  assert.equal(await readResponseText(makeResponse("safe"), 16), "safe");
});

test("private address classification covers IPv4 and IPv6 ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("concurrency helper preserves order and enforces its limit", async () => {
  let active = 0;
  let maximum = 0;
  const values = await mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(values, [0, 2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});
