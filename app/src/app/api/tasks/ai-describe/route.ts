import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { getDeepSeekConfig } from "@/lib/config";
import { reportLocale, languageName } from "@/lib/i18n-server";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = await rateLimit(`ai-describe:${session.user.id}`, 20, 5 * 60 * 1000);
  if (!rl.ok) {
    const t = await getTranslations("errors");
    return NextResponse.json({ error: t("rateLimited", { seconds: rl.retryAfter }) }, { status: 429 });
  }

  const { title, currentDescription } = await req.json();
  if (!title || title.trim().length < 3) {
    return NextResponse.json({ error: "Title too short" }, { status: 400 });
  }

  const { apiKey, baseUrl, model } = await getDeepSeekConfig();
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 500 });

  // Generated content follows the workspace (admin-chosen) AI-output language.
  const lang = languageName(await reportLocale());

  const systemPrompt = `You are a team assistant. Generate a short, clear task description.
The description must be specific and actionable, 1-3 sentences max.
Do not use markdown, asterisks, or headings. Plain text only.
Do not repeat the task title verbatim in the description.
Respond in ${lang}.`;

  const userPrompt = currentDescription
    ? `Task title: "${title}"\nCurrent description: "${currentDescription}"\n\nRewrite the description to be clearer, more specific and more actionable. Return only the description text.`
    : `Task title: "${title}"\n\nWrite a short description for this task. Return only the description text.`;

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
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("DeepSeek error:", err);
      return NextResponse.json({ error: "AI request failed" }, { status: 502 });
    }

    const data = await res.json();
    const description = data.choices?.[0]?.message?.content?.trim() || "";

    return NextResponse.json({ description });
  } catch (e: any) {
    console.error("AI describe error:", e);
    return NextResponse.json({ error: "AI request failed" }, { status: 502 });
  }
}
