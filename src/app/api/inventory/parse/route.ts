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
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: `You are a helper that formats inventory requests for a vacation rental cleaning team.
The user will describe items they need restocked or replaced in natural language (possibly from voice-to-text, so expect rough grammar).
Parse the input into a JSON array of objects with these fields:
- "item": string (the item name, cleaned up)
- "quantity": number (default to 1 if not specified)
- "notes": string (any extra context, or empty string)

Return ONLY the JSON array, no markdown, no explanation.`,
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
