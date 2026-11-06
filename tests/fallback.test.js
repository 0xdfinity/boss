import { test } from "node:test";
import assert from "node:assert/strict";
import { localVerdict, UNUSABLE } from "../src/near-ai/client.js";

test("blurry evidence is refused without calling any model", () => {
  const r = localVerdict("task-1", "blurry");
  assert.equal(r.ok, false);
  assert.ok(r.confidence < 0.5);
  assert.match(r.reason, /photo unusable/);
});

test("usable evidence passes locally and reports demo mode", () => {
  const r = localVerdict("task-1", "photo:task-1.jpg");
  assert.equal(r.ok, true);
  assert.equal(r.mode, "local-demo");
});

test("evidence regex matches the blurry batch case", () => {
  assert.ok(UNUSABLE.test("blurry"));
  assert.ok(UNUSABLE.test("none supplied"));
  assert.ok(!UNUSABLE.test("photo:shop-001"));
});
