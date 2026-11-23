import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAddress, friendlyDate, photoFacts } from "../src/lib/prefill.ts";

test("camera dates read naturally", () => {
  assert.equal(friendlyDate("2019-07-04"), "July 4, 2019");
  assert.equal(friendlyDate("2019-07-04T10:30:00"), "July 4, 2019");
  assert.equal(friendlyDate("1965-08"), "August 1965");
  assert.equal(friendlyDate("1958"), "1958");
  assert.equal(friendlyDate("sometime"), "sometime");
});

test("OpenStreetMap addresses become short place names", () => {
  assert.equal(formatAddress({ suburb: "7th Arrondissement", city: "Paris", state: "Ile-de-France", country: "France" }), "Paris, Ile-de-France, France");
  assert.equal(formatAddress({ village: "Collegeville", county: "Stearns County", state: "Minnesota", country: "United States" }), "Collegeville, Minnesota, United States");
  assert.equal(formatAddress({ park: "Yellowstone National Park", county: "Park County", state: "Wyoming", country: "United States" }), "Yellowstone National Park, Park County, Wyoming, United States");
  assert.equal(formatAddress({ country: "Iceland" }), "Iceland");
});

test("files without readable metadata give nothing to fill", () => {
  assert.deepEqual(photoFacts(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), {});
  assert.deepEqual(photoFacts(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), {});
});
