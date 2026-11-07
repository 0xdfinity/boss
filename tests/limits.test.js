import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Limits, clientIp } from "../src/server/limits.js";

const clock = (iso) => {
  let t = new Date(iso);
  const now = () => new Date(t);
  now.advance = (ms) => {
    t = new Date(t.getTime() + ms);
  };
  return now;
};

const fresh = (opts = {}) =>
  new Limits({
    file: join(mkdtempSync(join(tmpdir(), "boss-limits-")), "limits.json"),
    now: clock("2026-11-07T12:00:00Z"),
    perIpPerDay: 2,
    globalPerDay: 4,
    concurrent: 2,
    maxBudget: 8,
    ...opts,
  });

test("one address gets its daily jobs, then a 429", () => {
  const limits = fresh();
  assert.equal(limits.check("1.1.1.1").ok, true);
  limits.begin("1.1.1.1").release();
  limits.begin("1.1.1.1").release();

  const third = limits.check("1.1.1.1");
  assert.equal(third.ok, false);
  assert.equal(third.code, "ip");
  assert.match(third.reason, /2 demo jobs/);
  assert.ok(third.retryAfter > 0);
});

test("a different address still gets in", () => {
  const limits = fresh({ perIpPerDay: 1, globalPerDay: 10 });
  limits.begin("1.1.1.1").release();
  assert.equal(limits.check("1.1.1.1").ok, false);
  assert.equal(limits.check("2.2.2.2").ok, true);
});

test("the global cap stops everyone, whatever the address", () => {
  const limits = fresh({ perIpPerDay: 5, globalPerDay: 2 });
  limits.begin("1.1.1.1").release();
  limits.begin("2.2.2.2").release();

  const next = limits.check("3.3.3.3");
  assert.equal(next.ok, false);
  assert.equal(next.code, "daily");
  assert.match(next.reason, /2 jobs for today/);
});

test("a running job holds the concurrency slot until it is released", () => {
  const limits = fresh({ concurrent: 1 });
  const first = limits.begin("1.1.1.1");
  assert.equal(first.ok, true);

  const second = limits.check("2.2.2.2");
  assert.equal(second.ok, false);
  assert.equal(second.code, "concurrent");

  first.release();
  first.release(); // idempotent: a double release must not open two slots
  assert.equal(limits.check("2.2.2.2").ok, true);
});

test("a new UTC day resets the counts", () => {
  const now = clock("2026-11-07T23:00:00Z");
  const limits = fresh({ now, globalPerDay: 1, perIpPerDay: 1 });
  limits.begin("1.1.1.1").release();
  assert.equal(limits.check("1.1.1.1").ok, false);

  now.advance(2 * 60 * 60 * 1000); // 01:00Z the next day
  const after = limits.check("1.1.1.1");
  assert.equal(after.ok, true);
  assert.equal(limits.snapshot("1.1.1.1").global.used, 0);
});

test("counts survive a restart when a disk is mounted", () => {
  const file = join(mkdtempSync(join(tmpdir(), "boss-limits-")), "limits.json");
  const now = clock("2026-11-07T12:00:00Z");
  const first = new Limits({ file, now, perIpPerDay: 1, globalPerDay: 10 });
  first.begin("1.1.1.1").release();
  assert.ok(existsSync(file));

  const second = new Limits({ file, now, perIpPerDay: 1, globalPerDay: 10 });
  assert.equal(second.check("1.1.1.1").ok, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).global, 1);
});

test("a request cannot choose a budget above the ceiling", () => {
  const limits = fresh({ maxBudget: 8 });
  assert.equal(limits.clampBudget(1_000_000), 8);
  assert.equal(limits.clampBudget("-5"), 8);
  assert.equal(limits.clampBudget("3.5"), 3.5);
  assert.equal(limits.clampBudget(undefined, 5), 5);
});

test("spec storage has its own cap so it cannot fill the disk", () => {
  const limits = fresh({ specsPerIp: 2 });
  assert.equal(limits.allowSpec("1.1.1.1").ok, true);
  assert.equal(limits.allowSpec("1.1.1.1").ok, true);
  const third = limits.allowSpec("1.1.1.1");
  assert.equal(third.ok, false);
  assert.equal(third.code, "spec");
  // A spec is not a job: it must not consume the job allowance.
  assert.equal(limits.snapshot("1.1.1.1").perIp.used, 0);
});

test("the forwarded address is only trusted when configured", () => {
  const req = { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "::ffff:127.0.0.1" } };
  assert.equal(clientIp(req, true), "9.9.9.9");
  assert.equal(clientIp(req, false), "127.0.0.1");
});
