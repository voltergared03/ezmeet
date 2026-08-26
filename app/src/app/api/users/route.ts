import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unsuppressEmail } from '@/lib/suppression';
import { isValidEmail } from '@/lib/form-rules';
import { hashPassword, passwordPolicyError } from "@/lib/password";
import { sendEmail } from "@/lib/email";
import { readConfig, CONFIG_DEFAULTS, publicBaseUrl } from "@/lib/config";
import { getTranslator, workspaceLocale } from "@/lib/i18n-server";
import { getCurrentOrgId, ensureMembership } from "@/lib/org";
import { getTranslations } from "next-intl/server";

// GET /api/users — list workspace users (all authenticated users)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      // Needed by the list to mark a blocked account and offer to unblock it — without
      // it the UI cannot tell the two states apart.
      status: true,
      lastLogin: true,
      createdAt: true,
      passwordHash: true,
      preferences: true,
      clickupListId: true,
    } as any,
    orderBy: { createdAt: "asc" },
  });

  // Expose only whether a password is set (never the hash). Also surface the
  // forced spoken language so admins can see/change it in the Users list.
  const isAdmin = session.user.role === "admin";
  const safe = (users as any[]).map(({ passwordHash, preferences, clickupListId, ...u }) => ({
    ...u,
    hasPassword: !!passwordHash,
    spokenLanguage: (preferences as any)?.spokenLanguage ?? null,
    spokenLanguageLocked: !!(preferences as any)?.spokenLanguageLocked,
    // Admin-only: every authenticated user can read this route.
    ...(isAdmin ? { clickupListId: clickupListId ?? null } : {}),
  }));

  return NextResponse.json(safe);
}

// POST /api/users — admin creates a credentials (email+password) user.
// Admin sets a temporary password (shared out-of-band) and the user is forced
// to change it on first login. A credentials email is also sent if SMTP works.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const errT = await getTranslations("errors");
  const body = await req.json().catch(() => ({} as any));
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const role = body.role === "admin" ? "admin" : "member";
  const password = String(body.password || "");

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: errT("invalidEmail") }, { status: 400 });
  }
  const pwErr = passwordPolicyError(password);
  if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: errT("emailExists") }, { status: 409 });
  }

  const cfg = await readConfig(["WS_TIMEZONE", "WS_LANGUAGE", "WS_NAME"]);
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      name: name || email.split("@")[0],
      role,
      status: "active",
      passwordHash,
      mustChangePassword: true,
      timezone: cfg.WS_TIMEZONE || CONFIG_DEFAULTS.WS_TIMEZONE,
      preferences: { language: cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE },
    } as any,
    select: { id: true, email: true, name: true, role: true },
  });
  // Someone re-added after being deleted must be reachable again.
  await unsuppressEmail(email);

  // Multi-tenancy: enroll the new user into the current org.
  const orgId = await getCurrentOrgId(session);
  if (orgId) await ensureMembership(orgId, user.id, role === "admin" ? "ADMIN" : "MEMBER");

  // Best-effort credentials email (no-ops if SMTP isn't configured).
  const wsName = cfg.WS_NAME || CONFIG_DEFAULTS.WS_NAME;
  const appUrl = await publicBaseUrl();
  const loginUrl = appUrl ? `${appUrl}/login` : "/login";
  // Welcome the new user in their own language (workspace default at creation).
  const t = getTranslator(await workspaceLocale());
  let emailed = false;
  try {
    const r = await sendEmail({
      to: email,
      template: "credentials",
      subject: t("emails.credentials.subject", { workspace: wsName }),
      text: t("emails.credentials.bodyText", { workspace: wsName, email, password, url: loginUrl }),
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;background:#0f1115;border-radius:14px;color:#e8eaed">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px">${wsName}</div>
        <p style="color:#9aa0a6;margin:0 0 14px;line-height:1.5">${t("emails.credentials.intro")}</p>
        <div style="background:#1a1d24;border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.7">
          <div>${t("emails.credentials.emailLabel")}: <b>${email}</b></div>
          <div>${t("emails.credentials.passwordLabel")}: <b>${password}</b></div>
        </div>
        ${appUrl ? `<a href="${loginUrl}" style="display:inline-block;margin-top:16px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${t("emails.credentials.cta")} →</a>` : ""}
      </div>`,
    });
    emailed = !!r?.ok;
  } catch {
    emailed = false;
  }

  return NextResponse.json({ ok: true, user, emailed }, { status: 201 });
}
