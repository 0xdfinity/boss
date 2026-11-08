import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, wordCount, refusal, similarity, jaccard, planStages, artifactHint, wordBounds, targetWords, isWordCap, toPlainText } from "../src/firm/plan.js";

const [research, draft, critique, revise] = STAGES;

test("word sorties: counting, refusal, similarity", () => {
  assert.equal(wordCount("one two  three\nfour"), 4);
  assert.ok(refusal("I cannot help with that"));
  assert.ok(!refusal("Here is the finished copy."));
  assert.equal(similarity("alpha beta gamma delta", "alpha beta gamma delta"), 1);
  assert.equal(similarity("alpha beta", "zulu yankee"), 0);
});

test("research rejects thin or unstructured output", () => {
  assert.equal(research.check("too short").ok, false);
  const thin = "audience constraints " + "word ".repeat(20);
  assert.equal(research.check(thin).ok, false);
  const good =
    "audience: café owners who waste bread daily. " +
    "assumption: they close at 18:00. constraint: no new hardware. constraint: under 30 minutes a day. " +
    "facts: surplus is highest on weekdays; discounting at 18:00 clears stock; regulars respond to SMS. " +
    "positioning must stay local. keep the copy short and concrete. ".repeat(2);
  assert.equal(research.check(good).ok, true);
});

test("draft rejects a restatement of the research", () => {
  const prior = "audience café owners constraint no hardware surplus bread six pm";
  assert.equal(draft.check(prior + " " + prior, prior).ok, false);
  const original =
    "Six O'Clock Bread: every weekday at 18:00 we bag the day's surplus loaves and sell them for £2. " +
    "Three bags per shop, first come first served, collection only. We text 40 regulars at 17:45. " +
    "Last week we cleared 92% of surplus and cut waste cost by £180.";
  assert.equal(draft.check(original, prior).ok, true);
});

test("critique must be actionable", () => {
  assert.equal(critique.check("it is fine", "").ok, false);
  const good =
    "Score 3/5 on clarity, 2/5 on specificity, 4/5 on usefulness. Weakest line: 'great bread' — replace with the weight and price. " +
    "Weakest line: 'soon' — give the exact time. Weakest line: 'locals' — name the street. Fix each with a concrete noun.";
  assert.equal(critique.check(good, "").ok, true);
});

test("revise must differ from the draft", () => {
  const draftText = "Six O'Clock Bread sells surplus loaves at 18:00 for two pounds a bag.";
  assert.equal(revise.check(draftText, draftText).ok, false);
  const revised =
    "Six O'Clock Bread. Weekdays 18:00. Two pounds a bag, three bags a shop. " +
    "We text our regulars at 17:45 with the day's list and hold a bag for ten minutes. " +
    "Last week we cleared 92% of surplus and cut waste cost by 180 pounds. " +
    "Collection only, no delivery, pay at the counter. " +
    "If bread remains at 18:30 it goes to the shelter on Mill Street.";
  assert.equal(revise.check(revised, draftText).ok, true);
});

test("a rewrite is accepted without invented numbers", () => {
  const brief = "Rewrite this pitch in plain English and cut it to 60 words: 'We leverage synergies.'";
  const rewrite = "We combine teams with different skills so the work creates more value.";
  assert.equal(draft.check(rewrite, "research notes about audience", "", brief).ok, true);
  // A long-form brief still has to earn its place with specifics.
  const long = "We combine teams with different skills so the work creates more value for everyone involved.";
  assert.equal(draft.check(long, "notes", "", "Write a product description").ok, false);
});

test("a word limit is a ceiling, not a target to pad to", () => {
  const brief = "Rewrite this pitch and cut it to 60 words";
  assert.equal(targetWords(brief), 60);
  assert.equal(isWordCap(brief), true);
  const bounds = wordBounds(brief);
  assert.ok(bounds.min <= 10, "a cap must not force padding");
  assert.ok(bounds.max >= 60 && bounds.max <= 70);
  // "in 90 words" is a target, so it gets a real floor and ceiling.
  const exact = wordBounds("Summarise the report in 90 words");
  assert.ok(exact.min >= 70 && exact.max <= 110);
});

test("jaccard tells a real edit from an unchanged draft", () => {
  const a = "alpha beta gamma delta epsilon";
  assert.equal(jaccard(a, a), 1);
  assert.ok(jaccard(a, `${a} zulu`) < 1, "a superset is still a change");
  assert.equal(jaccard("alpha beta", "zulu yankee"), 0);
});

test("scores arrive as numbers, ratios, or percentages", async () => {  const { parseScore } = await import("../src/firm/judge.js");
  assert.equal(parseScore(85), 85);
  assert.equal(parseScore("85"), 85);
  assert.equal(parseScore("85/100"), 85);
  assert.equal(parseScore("8.5/10"), 85);
  assert.equal(parseScore("85%"), 85);
  assert.equal(parseScore(120), 100);
  assert.equal(parseScore("no score"), null);
});

test("markdown markers are stripped from what the client receives", () => {
  const raw = "## Plan\n\n**Strongest tagline:** one\n- **Price:** $2\n__Note__ kept";
  const clean = toPlainText(raw);
  assert.equal(clean.includes("**"), false);
  assert.equal(clean.includes("##"), false);
  assert.match(clean, /Strongest tagline: one/);
  assert.match(clean, /Price: \$2/);
  assert.match(clean, /Note kept/);
});

test("plan is four stages and the hint tracks the brief", () => {
  const stages = planStages("write taglines");
  assert.deepEqual(stages.map((s) => s.kind), ["research", "draft", "critique", "revise"]);
  assert.equal(stages[0].brief, "write taglines");
  assert.match(artifactHint("write 5 taglines"), /options/);
  assert.match(artifactHint("write 5 numbered checks before releasing escrow"), /checklist/);
  assert.match(artifactHint("make a launch plan"), /plan/);
});
