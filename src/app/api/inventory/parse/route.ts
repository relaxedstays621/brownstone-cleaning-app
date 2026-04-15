import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { text } = await req.json();
  if (!text) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You format messy inventory requests into clean JSON for a vacation rental cleaning team.

Input will be natural speech, often from voice-to-text. Expect: typos, bad grammar, repeated words, written-out numbers, casual phrasing, and weird items. This is NOT a filter — include EVERY item mentioned, no matter how unusual (hot dogs, soups, etc.). Never reject or skip items.

Rules:
- Convert written numbers to digits: "eight" → 8, "a dozen" → 12, "a couple" → 2, "a few" → 3
- Fix stutters/repeats: "hand soap hand soap dispensers" → 1 hand soap dispenser
- Fix typos: "tolet paper" → "Toilet Paper"
- Capitalize item names cleanly: "toilet rolls" → "Toilet Rolls"
- Default quantity to 1 if not specified
- If the input is vague but has ANY meaning, extract what you can
- NEVER return an empty array unless the input is truly empty

Return ONLY a JSON array (no markdown, no backticks, no explanation) with objects:
{"item": string, "quantity": number, "notes": string}

Example input: "wee need eight toilet rolls, 1 hand soap hand soap dispensers, 9 hot dogs, eight soups"
Example output: [{"item":"Toilet Rolls","quantity":8,"notes":""},{"item":"Hand Soap Dispenser","quantity":1,"notes":""},{"item":"Hot Dogs","quantity":9,"notes":""},{"item":"Soups","quantity":8,"notes":""}]`,
    messages: [{ role: "user", content: text }],
  });

  const content = message.content[0];
  const responseText = content.type === "text" ? content.text : "";

  let items;
  try {
    items = JSON.parse(responseText);
  } catch {
    items = [{ item: text, quantity: 1, notes: "Could not parse automatically" }];
  }

  return NextResponse.json({ items });
}
