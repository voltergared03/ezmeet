import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getDeepSeekConfig } from "@/lib/config";
import { reportLocale, languageName } from "@/lib/i18n-server";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = await rateLimit(`ai-agenda:${session.user.id}`, 20, 5 * 60 * 1000);
  if (!rl.ok) {
    const t = await getTranslations("errors");
    return NextResponse.json({ error: t("rateLimited", { seconds: rl.retryAfter }) }, { status: 429 });
  }

  const { title, description, currentAgenda } = await req.json();
  if (!title || title.trim().length < 3) {
    return NextResponse.json({ error: "Title too short" }, { status: 400 });
  }

  const { apiKey, baseUrl, model } = await getDeepSeekConfig();
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 500 });

  // Generated content follows the workspace (admin-chosen) AI-output language, not the
  // requesting user's interface language.
  const lang = languageName(await reportLocale());

  const systemPrompt = `You are a meeting-prep assistant. Generate a list of discussion questions/topics.
Each item is a specific question or topic, one short sentence.
Generate 4-7 items depending on the topic's complexity.
Return ONLY a JSON array of strings, e.g. ["Question 1", "Question 2", "Question 3"].
No markdown, no numbering, no extra text — just the JSON array.
Respond in ${lang}.`;

  let userPrompt = `Meeting title: "${title}"`;
  if (description) userPrompt += `\nDescription: "${description}"`;
  if (currentAgenda && currentAgenda.length > 0) {
    userPrompt += `\nCurrent items: ${JSON.stringify(currentAgenda)}`;
    userPrompt += `\n\nRegenerate the list — make it better and more specific. Return ONLY a JSON array.`;
  } else {
    userPrompt += `\n\nCreate a list of discussion questions. Return ONLY a JSON array.`;
  }

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("DeepSeek error:", err);
      return NextResponse.json({ error: "AI request failed" }, { status: 502 });
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "[]";

    let agenda: string[];
    try {
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      agenda = JSON.parse(cleaned);
      if (!Array.isArray(agenda)) agenda = [];
      agenda = agenda.filter((item: any) => typeof item === "string" && item.trim().length > 0);
    } catch {
      agenda = raw.split("\n").filter((l: string) => l.trim().length > 0).map((l: string) => l.replace(/^\d+\.\s*/, "").replace(/^-\s*/, "").trim());
    }

    return NextResponse.json({ agenda });
  } catch (e: any) {
    console.error("AI agenda error:", e);
    return NextResponse.json({ error: "AI request failed" }, { status: 502 });
  }
}
