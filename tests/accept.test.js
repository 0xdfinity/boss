// The market's acceptance rules. These are the checks that decide whether an
// escrow releases or refunds, so they get their own tests: a false pass here
// pays for work that was never done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRules } from "../src/firm/accept.js";
import { normaliseReasons } from "../src/firm/judge.js";

const spec = (brief, acceptance = []) => ({ brief, acceptance });

test("an empty delivery fails", () => {
  const r = checkRules(spec("Write five taglines"), "   ");
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /empty/i);
});

test("a refusal fails even when it is polite and well formed", () => {
  const r = checkRules(
    spec("Find one current statistic and cite the source URL.", ["includes a source URL"]),
    "I can't take this job. It requires browse, and this firm has no browse tool installed."
  );
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /refused/i);
});

test("the asked-for item count is enforced", () => {
  const brief = "Write 5 taglines for a coffee subscription.";
  const good = "1. First\n2. Second\n3. Third\n4. Fourth\n5. Fifth";
  const short = "1. First\n2. Second\n3. Third";
  assert.equal(checkRules(spec(brief), good).ok, true);
  const r = checkRules(spec(brief), short);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /asked for 5 items/i);
});

test("the count rule also reads checks, tests, and steps", () => {
  const brief = "Write 5 numbered checks a client can run before releasing an escrow job.";
  const good = "1. Hash matches\n2. Word count in bounds\n3. Every part answered\n4. No refused claim\n5. Source URL resolves";
  const short = "1. Hash matches\n2. Word count in bounds\n3. Every part answered";
  assert.equal(checkRules(spec(brief), good).ok, true);
  assert.equal(checkRules(spec(brief), short).ok, false);
});

test("a spec that requires a source URL rejects a delivery without one", () => {
  const brief = "Find one current statistic about coffee and include a source URL. Under 80 words.";
  const noLink = "Global coffee consumption is large and growing every year, according to several reports.";
  const withLink = "Global coffee consumption reached about 10.5 million tonnes in 2024. https://example.org/coffee";
  const r = checkRules(spec(brief, ["includes a source URL"]), noLink);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" "), /no source URL/i);
  assert.equal(checkRules(spec(brief, ["includes a source URL"]), withLink).ok, true);
});

test("a word cap is a ceiling, not a target to pad to", () => {
  const brief = "Rewrite this pitch in plain English and cut it to 60 words: 'We leverage synergies.'";
  const short = "We work together to create value.";
  assert.equal(checkRules(spec(brief), short).ok, true);
  const padded = Array.from({ length: 90 }, () => "word").join(" ");
  assert.equal(checkRules(spec(brief), padded).ok, false);
});

test("a model that packs every reason into one string is split back apart", () => {
  // Seen from a Groq model: one array element containing the separators.
  const packed = ['Delivers five taglines","Includes a strongest pick","Stays under the limit'];
  assert.deepEqual(normaliseReasons(packed), [
    "Delivers five taglines",
    "Includes a strongest pick",
    "Stays under the limit",
  ]);
  assert.deepEqual(normaliseReasons(["one", "two", "three", "four"]), ["one", "two", "three"]);
  assert.deepEqual(normaliseReasons(undefined), []);
  assert.deepEqual(normaliseReasons('["only one"]'), ["only one"]);
});
