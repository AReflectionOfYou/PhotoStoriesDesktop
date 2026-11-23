// Turning a transcript into a short story, plus suggested title, people,
// place and date. One interface, one adapter per provider, and the same
// prompt for every provider so results feel consistent. With no API key the
// light local cleanup is used. The person reviews and edits everything.

import Anthropic from "@anthropic-ai/sdk";
import { invoke } from "@tauri-apps/api/core";
import { localCleanup, localSuggestions, type Suggestions } from "./local-cleanup";
import type { Provider, Settings } from "./settings";

export type { Suggestions };

export interface CleanupProvider {
  readonly id: Provider;
  readonly model: string | null;
  clean(transcript: string, knownNames: string[]): Promise<Suggestions>;
}

export const INSTRUCTIONS = `You help someone preserve the story behind a photo. You receive a transcript of them talking about the photo.

Write "story": the same telling, lightly polished. Fix punctuation, capitals and obvious mis-heard words; remove filler words (um, uh, you know), false starts and repeated words; add paragraph breaks. Keep their own words, voice, tense and order. Do not add facts, embellish, summarize, explain, or change what they meant. If something is unclear, keep their wording.

Also suggest, only from what they said:
- "title": a short title for the photo (under eight words, using their words where possible), or "" if nothing fits.
- "people": the people named as being in the photo or central to the story, as they named them.
- "place": where the photo was taken, or "".
- "date": when, as they said it (for example "summer of 1965" or "the 1970s"), or "".
Never invent anything. Leave a field empty when the transcript doesn't say it.`;

export const SCHEMA = {
  type: "object",
  properties: {
    story: { type: "string" },
    title: { type: "string" },
    people: { type: "array", items: { type: "string" } },
    place: { type: "string" },
    date: { type: "string" },
  },
  required: ["story", "title", "people", "place", "date"],
  additionalProperties: false,
} as const;

export const userMessage = (transcript: string, knownNames: string[]) =>
  `${knownNames.length ? `Names already used in this collection (spell them this way if they appear): ${knownNames.join(", ")}\n\n` : ""}Transcript:\n${transcript}`;

function parse(text: string): Suggestions {
  const v = JSON.parse(text);
  return {
    story: String(v.story ?? ""),
    title: String(v.title ?? ""),
    people: Array.isArray(v.people) ? v.people.map(String).filter(Boolean) : [],
    place: String(v.place ?? ""),
    date: String(v.date ?? ""),
  };
}

export class LocalCleanup implements CleanupProvider {
  readonly id = "none" as const;
  readonly model = null;
  async clean(transcript: string, knownNames: string[]) {
    return { story: localCleanup(transcript), ...localSuggestions(transcript, knownNames) };
  }
}

export class AnthropicCleanup implements CleanupProvider {
  readonly id = "anthropic" as const;
  private client: Anthropic;
  constructor(apiKey: string, readonly model: string) {
    // A desktop app calling with the person's own key, from their own computer.
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }
  async clean(transcript: string, knownNames: string[]) {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: userMessage(transcript, knownNames) }],
    });
    if (response.stop_reason === "refusal") throw new Error("The cleanup service declined this story. You can use the local cleanup instead.");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return parse(text);
  }
}

/** OpenAI's Chat Completions API with a strict JSON schema, using the same instructions. */
export class OpenAICleanup implements CleanupProvider {
  readonly id = "openai" as const;
  constructor(private apiKey: string, readonly model: string) {}
  async clean(transcript: string, knownNames: string[]) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: userMessage(transcript, knownNames) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "photo_story", strict: true, schema: SCHEMA } },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const msg = body.choices?.[0]?.message;
    if (msg?.refusal) throw new Error("The cleanup service declined this story. You can use the local cleanup instead.");
    return parse(msg?.content ?? "{}");
  }
}

/** The provider chosen in settings, or the local cleanup when there's no key. */
export async function chooseProvider(s: Settings): Promise<CleanupProvider> {
  if (s.provider === "none") return new LocalCleanup();
  const key = await invoke<string | null>("get_api_key", { provider: s.provider }).catch(() => null);
  if (!key) return new LocalCleanup();
  return s.provider === "anthropic" ? new AnthropicCleanup(key, s.anthropicModel) : new OpenAICleanup(key, s.openaiModel);
}

export const describeError = (e: unknown) =>
  e instanceof Anthropic.AuthenticationError
    ? "The Anthropic API key was not accepted. Check it in Settings."
    : e instanceof Anthropic.RateLimitError
      ? "The cleanup service is busy. Try again in a minute, or use the local cleanup."
      : e instanceof Anthropic.APIConnectionError
        ? "Couldn't reach the cleanup service. Check the internet connection, or use the local cleanup."
        : e instanceof Error
          ? e.message
          : String(e);
