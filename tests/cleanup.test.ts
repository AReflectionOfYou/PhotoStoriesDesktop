import assert from "node:assert/strict";
import { test } from "node:test";
import { localCleanup, localSuggestions } from "../src/lib/local-cleanup.ts";

test("local cleanup removes fillers and stutters but keeps the speaker's words", () => {
  const raw = "um so this is the the house we grew up in uh my dad built it himself, you know, in nineteen sixty and um we we painted it red";
  const out = localCleanup(raw);
  assert.ok(!/\bum\b|\buh\b/i.test(out), out);
  assert.ok(!/\bthe the\b|\bwe we\b/i.test(out), out);
  assert.ok(!/you know/i.test(out), out);
  for (const w of ["house we grew up in", "my dad built it himself", "painted it red"]) assert.ok(out.includes(w), w);
  assert.match(out, /^So this is/, "a leading \"so\" is the speaker's own word");
  assert.match(out, /\.$/);
});

test("local cleanup capitalizes sentences and I, and makes paragraphs", () => {
  const out = localCleanup("i was five. we lived there. it was cold. i loved it. then we moved. i cried");
  assert.equal(out, "I was five. We lived there. It was cold. I loved it.\n\nThen we moved. I cried.");
});

test("local cleanup leaves words like 'like' and 'so' inside sentences alone", () => {
  assert.equal(localCleanup("It was so cold, like ice."), "It was so cold, like ice.");
});

test("suggestions: known names, relations, dates and places", () => {
  const s = localSuggestions("This is Grandma Rose and Uncle Bob at the lake house in Duluth, Minnesota in the summer of 1965. Robert Example took it.", ["Robert Example", "Walter"]);
  assert.deepEqual(s.people.sort(), ["Grandma Rose", "Robert Example", "Uncle Bob"]);
  assert.equal(s.date, "summer of 1965");
  assert.equal(s.place, "Duluth, Minnesota");
});

test("suggestions: decades, and nothing invented", () => {
  assert.equal(localSuggestions("We went there a lot in the 1970s.", []).date, "the 1970s");
  const none = localSuggestions("we just liked sitting there", []);
  assert.deepEqual(none, { title: "", people: [], place: "", date: "" });
});
