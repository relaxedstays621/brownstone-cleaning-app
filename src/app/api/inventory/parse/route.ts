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

  console.log("[inventory/parse] Raw input:", text);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let responseText = "";
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You convert inventory requests into a JSON array. This is for a vacation rental cleaning team.

Input is messy natural speech or voice-to-text. DO NOT refuse. DO NOT explain. DO NOT use markdown.

RULES:
1. Return ONLY a raw JSON array. No backticks. No "json" label. No prose. Just [ ... ]
2. Each object: {"item": "Item Name", "quantity": 1, "notes": ""}
3. Written numbers become digits: "eight" = 8, "dozen" = 12, "couple" = 2, "few" = 3
4. Deduplicate stutters: "hand soap hand soap dispensers" = 1 Hand Soap Dispenser
5. Fix typos: "tolet" = "Toilet", "papper" = "Paper"
6. Title Case all item names
7. Default quantity = 1 if not stated
8. Include ALL items even if unusual (food, random objects, etc.)
9. NEVER return an empty array
10. If input is a single word, return it as one item with quantity 1

EXAMPLE:
Input: 8 toilet rolls, 1 hand soap, 9 hot dogs
Output: [{"item":"Toilet Rolls","quantity":8,"notes":""},{"item":"Hand Soap","quantity":1,"notes":""},{"item":"Hot Dogs","quantity":9,"notes":""}]`,
      messages: [{ role: "user", content: text }],
    });

    const content = message.content[0];
    responseText = content.type === "text" ? content.text : "";
    console.log("[inventory/parse] Claude response:", responseText);
  } catch (err) {
    console.error("[inventory/parse] Claude API error:", err);
    return NextResponse.json({
      items: [{ item: text.trim(), quantity: 1, notes: "" }],
    });
  }

  let items;
  try {
    // Strip markdown code fences if Claude wraps the response
    const cleaned = responseText.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
    items = JSON.parse(cleaned);
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Empty or non-array result");
    }
  } catch {
    console.warn("[inventory/parse] JSON parse failed, falling back to raw text split");
    // Last resort: split by commas and create items manually
    items = text
      .split(/[,\n]+/)
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0)
      .map((s: string) => {
        const match = s.match(/^(\d+)\s+(.+)/);
        if (match) {
          return { item: match[2].trim(), quantity: parseInt(match[1], 10), notes: "" };
        }
        return { item: s, quantity: 1, notes: "" };
      });
    if (items.length === 0) {
      items = [{ item: text.trim(), quantity: 1, notes: "" }];
    }
  }

  return NextResponse.json({ items });
}
