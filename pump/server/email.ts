import { config } from "./config";
import { log } from "./vite";

export interface MagicLinkEmail {
  to: string;
  link: string;
}

/** True when magic links cannot be emailed and are shown in the UI instead. */
export const magicLinkDevMode = !config.email.resendApiKey;

export async function sendMagicLink({ to, link }: MagicLinkEmail): Promise<void> {
  if (magicLinkDevMode) {
    log(`[dev] magic link for ${to}: ${link}`, "email");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [to],
      subject: `Sign in to ${config.appName}`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1d2b39">
          <h1 style="font-size:20px;margin:0 0 16px">Sign in to ${config.appName}</h1>
          <p style="margin:0 0 24px;color:#6b7c93">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${link}" style="display:inline-block;background:#2e5bff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Sign in</a>
          <p style="margin:24px 0 0;font-size:12px;color:#858d92">If you didn't request this email you can safely ignore it.</p>
        </div>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Email provider error ${res.status}: ${body}`);
  }
}
