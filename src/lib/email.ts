// Transactional email via Resend's HTTP API (no SDK needed).
//
// Env:
//   RESEND_API_KEY  API key from resend.com
//   EMAIL_FROM      verified sender, e.g. "Vybe <noreply@vybecut.com>"
//
// Without a key (local dev) the email is logged to the console instead, so
// links can still be clicked from the terminal.

export async function sendEmail(opts: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Vybe <noreply@vybecut.com>";
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.error("[email] RESEND_API_KEY is not set; email not sent:", opts.subject);
      return false;
    }
    console.log(`[email] (dev, not sent) to=${opts.to} subject=${opts.subject}\n${opts.text}`);
    return true;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html, text: opts.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[email] Resend rejected:", res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] send failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
