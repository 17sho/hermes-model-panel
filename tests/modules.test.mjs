import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteFile, serializeFile } from "../src/lib/atomic-files.js";
import { publicError, safeEqual } from "../src/lib/errors.js";
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
