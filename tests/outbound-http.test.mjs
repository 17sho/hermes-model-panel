import assert from "node:assert/strict";
import test from "node:test";
import { Headers, Response } from "undici";

import {
  classifyAddress,
  isAddressAllowed,
  safeOutboundFetch,
  Semaphore,
  validateOutboundUrl,
} from "../src/lib/outbound-http.js";

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 }];

test("address classifier handles security-sensitive IPv4 and IPv6 ranges", () => {
  const cases = new Map([
    ["0.0.0.0", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "cgnat"],
    ["169.254.169.254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["224.0.0.1", "multicast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fd00::1", "ula"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["2606:4700:4700::1111", "public"],
  ]);
  for (const [address, expected] of cases)
    assert.equal(classifyAddress(address), expected, address);
  assert.equal(isAddressAllowed("127.0.0.1"), true);
  assert.equal(isAddressAllowed("10.0.0.1"), false);
  assert.equal(isAddressAllowed("10.0.0.1", { allowPrivate: true }), true);
  assert.equal(
    isAddressAllowed("169.254.169.254", { allowPrivate: true }),
    false,
  );
});

test("URL validation permits HTTP(S) loopback but rejects credentials, private DNS and unsafe schemes", async () => {
  assert.equal(
    (await validateOutboundUrl("http://127.0.0.1:8080/v1")).url.hostname,
    "127.0.0.1",
  );
  await assert.rejects(() => validateOutboundUrl("file:///etc/passwd"), /HTTP/);
  await assert.rejects(
    () =>
      validateOutboundUrl("https://user:pass@example.test", {
        resolver: publicResolver,
      }),
    /凭据/,
  );
  await assert.rejects(
    () =>
      validateOutboundUrl("https://private.test", {
        resolver: async () => [{ address: "192.168.1.5", family: 4 }],
      }),
    /不允许/,
  );
  assert.equal(
    (
      await validateOutboundUrl("https://private.test", {
        allowPrivate: true,
        resolver: async () => [{ address: "192.168.1.5", family: 4 }],
      })
    ).url.hostname,
    "private.test",
  );
  await assert.rejects(
    () =>
      validateOutboundUrl("https://mixed.test", {
        resolver: async () => [
          { address: "203.0.113.5", family: 4 },
          { address: "fe80::1", family: 6 },
        ],
      }),
    /不允许/,
  );
});

test("safe fetch validates every redirect and limits redirect hops", async () => {
  const response = (status, location = "") =>
    new Response("", { status, headers: location ? { location } : {} });
  const visited = [];
  const fetchImpl = async (url) => {
    visited.push(String(url));
    return visited.length === 1
      ? response(302, "http://127.0.0.1/admin")
      : response(200);
  };
  const resolver = async (host) => [
    { address: host === "start.test" ? "203.0.113.1" : "127.0.0.1", family: 4 },
  ];
  const out = await safeOutboundFetch(
    "https://start.test/v1",
    {},
    { fetchImpl, resolver },
  );
  assert.equal(out.response.status, 200);
  assert.deepEqual(visited, [
    "https://start.test/v1",
    "http://127.0.0.1/admin",
  ]);

  const blocked = async () =>
    response(302, "http://169.254.169.254/latest/meta-data");
  await assert.rejects(
    () =>
      safeOutboundFetch(
        "https://start.test",
        {},
        { fetchImpl: blocked, resolver },
      ),
    /不允许/,
  );
  await assert.rejects(
    () =>
      safeOutboundFetch(
        "https://start.test",
        {},
        {
          maxRedirects: 3,
          resolver,
          fetchImpl: async () => response(302, "/again"),
        },
      ),
    /次数过多/,
  );
});

test("safe fetch does not forward provider credentials across origins", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return requests.length === 1
      ? new Response("", {
          status: 302,
          headers: { location: "https://other.test/final" },
        })
      : new Response("ok");
  };
  await safeOutboundFetch(
    "https://start.test/v1",
    { headers: { authorization: "Bearer secret", "x-api-key": "secret" } },
    { fetchImpl, resolver: publicResolver },
  );
  assert.equal(requests[0].headers.get("authorization"), "Bearer secret");
  assert.equal(requests[1].headers.get("authorization"), null);
  assert.equal(requests[1].headers.get("x-api-key"), null);
});

test("service semaphore caps active work, preserves results, and releases after rejection", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maximum = 0;
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, value) =>
      semaphore.run(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
        return value;
      }),
    ),
  );
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(maximum, 2);
  await assert.rejects(
    () =>
      semaphore.run(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(await semaphore.run(async () => "released"), "released");
});
