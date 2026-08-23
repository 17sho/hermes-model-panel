import test from "node:test";

test("legacy audit regression", async () => {
  await import("./audit-regression.mjs");
});
