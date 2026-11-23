// The cleanup used when no API key is set. It mostly keeps the speaker's own
// words: it removes filler sounds and stutters, fixes capitals and end
// punctuation, and adds paragraph breaks. It also suggests people, a place and
// a date from what was said, for the person to review. No network needed.

import { toEdtf } from "photostories-core";

export interface Suggestions {
  story: string;
  title: string;
  people: string[];
  place: string;
  date: string;
}

const FILLERS = /(^|[\s,])(?:u+m+|u+h+m*|e+r+m*|a+h+|hm+|mm+|mhm)(?=[\s,.!?]|$)[,]?/gi;

export function localCleanup(transcript: string): string {
  let t = ` ${transcript.replace(/\s+/g, " ")} `;
  t = t.replace(FILLERS, "$1");
  // "you know" and "I mean" only when set off as asides.
  t = t.replace(/,\s*(?:you know|i mean)\s*,/gi, ",");
  t = t.replace(/(^|[.!?]\s+)(?:you know|i mean|so|well),\s*/gi, "$1");
  // Stutters and repeats: "the the", "we went we went".
  for (let n = 3; n >= 1; n--) {
    const words = Array.from({ length: n }, () => "([\\w']+)").join(" ");
    const again = Array.from({ length: n }, (_, i) => `\\${i + 1}`).join(" ");
    t = t.replace(new RegExp(`\\b${words},? ${again}\\b`, "gi"), Array.from({ length: n }, (_, i) => `$${i + 1}`).join(" "));
  }
  t = t.replace(/\s+([,.!?;:])/g, "$1").replace(/([,.!?;:])(?=[^\s"')\]])/g, "$1 ").replace(/,+/g, ",").replace(/\s+/g, " ").trim();
  t = t.replace(/^[,.;:]\s*/, "").replace(/,\s*([.!?])/g, "$1");
  t = t.replace(/\bi\b/g, "I").replace(/\bi'(m|ve|ll|d)\b/gi, "I'$1");
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  if (t && !/[.!?"')]$/.test(t)) t += ".";
  // Paragraphs of about four sentences.
  const sentences = t.match(/[^.!?]+[.!?]+["')]*\s*/g) ?? [t];
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += 4) paras.push(sentences.slice(i, i + 4).join("").trim());
  return paras.filter(Boolean).join("\n\n");
}

const MONTH = "january|february|march|april|may|june|july|august|september|october|november|december";
const DATE_RE = new RegExp(
  `\\b(?:(?:early|mid|late|about|around|circa|maybe|probably|summer|winter|spring|fall|autumn|christmas|easter)\\s+(?:of\\s+)?){0,3}` +
    `(?:(?:${MONTH})\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?)?(?:(?:the\\s+)?(?:1[6-9]|20)?\\d0'?s|1[6-9]\\d{2}|20\\d{2})\\b`,
  "i",
);
const RELATIONS = "grandma|grandpa|granny|nana|nanna|papa|grandmother|grandfather|uncle|aunt|auntie|cousin|great[- ]grandma|great[- ]grandpa";
const STOP = new Set(["The", "A", "An", "We", "I", "It", "That", "This", "There", "Then", "And", "But", "So", "My", "Our", "He", "She", "They", "Christmas", "Easter", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", ...MONTH.split("|").map((m) => m[0].toUpperCase() + m.slice(1))]);

/** Suggest people, place and date from what was said, given names the project already knows. */
export function localSuggestions(text: string, knownNames: string[]): Omit<Suggestions, "story"> {
  const people = new Set<string>();
  for (const n of knownNames) if (n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) people.add(n);
  for (const m of text.matchAll(new RegExp(`\\b(?:${RELATIONS})\\s+[A-Z][a-z'-]+`, "gi"))) {
    const name = m[0].replace(/\s+/g, " ");
    people.add(name[0].toUpperCase() + name.slice(1));
  }
  for (const m of text.matchAll(/\bmy (?:brother|sister|mother|father|mom|dad|son|daughter|wife|husband|friend|cousin|aunt|uncle) ([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?)/g)) people.add(m[1]);
  const date = DATE_RE.exec(text)?.[0].trim() ?? "";
  let place = "";
  for (const m of text.matchAll(/\b(?:in|at|near|on|to)\s+((?:the\s+)?[A-Z][\w'-]+(?:\s+(?:[A-Z][\w'-]+|of|the|de|la))*(?:,\s*[A-Z][\w'-]+)?)/g)) {
    const words = m[1].replace(/^the\s+/, "").split(/[\s,]+/);
    if (words.every((w) => STOP.has(w) || /^\d/.test(w)) || [...people].some((p) => p.endsWith(m[1]))) continue;
    if (toEdtf(m[1]) && DATE_RE.test(m[1])) continue;
    place = m[1].replace(/^the\s+/, "");
    break;
  }
  return { title: "", people: [...people], place, date };
}
