import type { Metadata } from "next";
import { LegalPage, LEGAL, Bullets, Strong, A, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — Vybe",
  description: "What data Vybe collects, how it's used, who processes it, and your rights.",
};

const mail = <A href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</A>;

const sections: LegalSection[] = [
  {
    id: "collect",
    title: "Information we collect",
    body: (
      <Bullets items={[
        <><Strong>Account details.</Strong> Your email address, display name and a hashed password. If you sign in with Google, GitHub or Discord we receive only your basic profile (name, email, avatar) — no access to your files, repositories or messages.</>,
        <><Strong>Connected social accounts.</Strong> When you connect YouTube, TikTok, Instagram or X, the platform gives us access and refresh tokens plus basic channel/profile info. We use them only for the features you turn on (publishing, analytics, comment replies).</>,
        <><Strong>Content you work with.</Strong> Videos, audio and images you upload; links you import; clips you edit or export; captions, titles, schedules, editing styles and Auto-Pilot settings.</>,
        <><Strong>Platform data.</Strong> Post performance (views, likes, comments, reach) and, for Auto-Respond, the comments on your posts.</>,
        <><Strong>Billing details.</Strong> Your plan, billing interval and payment status. Card and crypto payments are handled by our payment processors — we never see or store your full card number.</>,
        <><Strong>Technical data.</Strong> Server logs (request time, IP address, browser, errors) kept for security and debugging.</>,
      ]} />
    ),
  },
  {
    id: "use",
    title: "How we use it",
    body: (
      <>
        <Bullets items={[
          "Run the service: import and store your videos, find and edit clips, render exports, and publish at the times you choose.",
          "Show analytics and campaign earnings for your posts.",
          "Reply to comments automatically when you set up Auto-Respond rules.",
          "Sign you in, keep your session secure, and prevent abuse.",
          "Process payments and enforce plan limits.",
          "Contact you about your account, billing or important changes.",
        ]} />
        <p>We don’t sell your personal information, we don’t use it for advertising, and we don’t use your videos to train AI models.</p>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI processing",
    body: (
      <>
        <p>
          Features like Auto-edit, subtitles, titles, covers, B-roll, reframing and style copying send the relevant parts of your
          clip (video frames, audio, transcript or text) to AI providers that process it on our behalf and return a result.
          Providers we use include Google (Gemini, Veo), Groq (speech-to-text and text models) and fal.ai (image generation),
          plus Pexels for stock B-roll searches.
        </p>
        <p>
          These providers act as processors for us under their API terms, which don’t allow them to use API data to train their
          models. AI output can be inaccurate — always review captions, titles and edits before you publish.
        </p>
      </>
    ),
  },
  {
    id: "google",
    title: "Google & YouTube data",
    body: (
      <>
        <p>
          Vybe uses YouTube API Services. By connecting a YouTube channel you also agree to the{" "}
          <A href="https://www.youtube.com/t/terms">YouTube Terms of Service</A>, and Google’s handling of your data is covered by the{" "}
          <A href="https://policies.google.com/privacy">Google Privacy Policy</A>.
        </p>
        <p>
          We request YouTube permissions only to upload videos you schedule, read your channel and video statistics, and manage
          comments if you use Auto-Respond. Vybe’s use and transfer of information received from Google APIs adheres to the{" "}
          <A href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</A>,
          including the Limited Use requirements. We don’t transfer this data to others except as needed to provide the features you use.
        </p>
        <p>
          You can revoke Vybe’s access at any time from the Accounts page or from your{" "}
          <A href="https://myaccount.google.com/permissions">Google security settings</A>.
        </p>
      </>
    ),
  },
  {
    id: "tiktok",
    title: "TikTok data",
    body: (
      <>
        <p>
          When you connect a TikTok account, you sign in on TikTok and approve the permissions Vybe asks for. We request only:
        </p>
        <Bullets items={[
          <><Strong>Basic profile (user.info.basic):</Strong> your TikTok open ID, display name and avatar, so we can show which account is connected.</>,
          <><Strong>Video upload (video.upload):</Strong> to send a clip to your TikTok inbox as a draft when you choose &ldquo;Send to TikTok drafts&rdquo;.</>,
          <><Strong>Direct post (video.publish):</Strong> to publish a clip when you click &ldquo;Post to TikTok&rdquo;, using the caption, privacy, interaction and disclosure settings you choose on that screen.</>,
        ]} />
        <p>
          TikTok also gives us access and refresh tokens. We store them on our servers to make the requests above and never send
          them to your browser. Vybe never posts to TikTok without you clicking Post, doesn&apos;t read your TikTok videos,
          followers or messages, and doesn&apos;t sell TikTok data or use it for advertising.
        </p>
        <p>
          When you disconnect TikTok on the Accounts page, we revoke Vybe&apos;s access with TikTok and delete the tokens. Deleting your
          Vybe account removes all of it. You can also remove Vybe in the TikTok app under Settings and privacy → Security &amp; permissions.
          TikTok&apos;s handling of your data is covered by the{" "}
          <A href="https://www.tiktok.com/legal/page/us/privacy-policy/en">TikTok Privacy Policy</A>.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who we share it with",
    body: (
      <>
        <p>We share data only with service providers who help us run Vybe, and only what they need:</p>
        <Bullets items={[
          <><Strong>Hosting & storage:</Strong> Vercel (app hosting and file storage) and Turso (database).</>,
          <><Strong>AI providers:</Strong> listed in the AI processing section above.</>,
          <><Strong>Payments:</Strong> Paddle and Polar (card payments, acting as merchant of record) and NOWPayments (crypto).</>,
          <><Strong>Social platforms:</Strong> YouTube, TikTok, Instagram and X — when you publish to or read from them.</>,
          <><Strong>Sign-in providers:</Strong> Google, GitHub and Discord, if you choose to sign in with them.</>,
        ]} />
        <p>We may also disclose information if required by law, to protect our users or the service, or as part of a merger or sale of the business (you’ll be notified).</p>
        <p>
          Platform policies: <A href="https://www.tiktok.com/legal/page/us/privacy-policy/en">TikTok</A> ·{" "}
          <A href="https://privacycenter.instagram.com/policy">Instagram</A> · <A href="https://x.com/en/privacy">X</A>.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies",
    body: (
      <p>
        We use an essential cookie to keep you signed in, short-lived cookies during sign-in to protect against forgery, a cookie
        that remembers which affiliate link brought you here (30 days), and a random device identifier we use only to prevent
        affiliate and sign-up fraud. We don’t use advertising or cross-site tracking cookies, so there’s nothing to opt out of.
      </p>
    ),
  },
  {
    id: "affiliates",
    title: "Affiliate program",
    body: (
      <p>
        If you join the affiliate program, we keep your payout details and, before your first payout, your legal name, country and
        postal address — to pay you, meet tax and sanctions obligations, and prevent fraud. We may ask you to verify your identity
        through a verification provider, which processes your ID document and selfie under its own privacy policy and tells us the result.
        For fraud prevention we compare one-way hashes of the IP addresses and device identifiers used on accounts (not the raw addresses).
        We keep payout records as long as tax law requires. See the <A href="/affiliate-terms">Affiliate Program Terms</A>.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <Bullets items={[
        "Account data: for as long as your account is open.",
        "Clips on the Free plan are deleted automatically after 7 days. Paid-plan clips are kept until you delete them or close your account.",
        "Social tokens: deleted as soon as you disconnect the account or close your Vybe account.",
        "Server logs: a limited period for security and debugging.",
        "Billing records: as long as tax and accounting law requires.",
        <>When you delete your account from the <A href="/account">Account &amp; data</A> page, your data and stored files are removed immediately. Billing records we must keep by law, and short-lived backups, are purged within 30 days.</>,
      ]} />
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        All traffic is encrypted with HTTPS, passwords are hashed, and social tokens are kept on our servers and never sent to
        your browser. No system is perfectly secure — if you think your account has been compromised, change your password,
        disconnect your social accounts and contact us right away.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <p>Depending on where you live (for example under the GDPR, UK GDPR or CCPA), you can:</p>
        <Bullets items={[
          <>Download a copy of your data at any time from <A href="/account">Account &amp; data</A>.</>,
          "Correct inaccurate data.",
          <>Delete your account and data yourself from <A href="/account">Account &amp; data</A> — it takes effect immediately.</>,
          "Object to or restrict certain processing, and withdraw consent at any time.",
          "Complain to your local data protection authority.",
        ]} />
        <p>For anything you can’t do from the app (like correcting data or objecting to processing), email {mail}. We’ll respond within 30 days. We never sell personal information, and we don’t treat you differently for using your rights.</p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        Our providers may process data in the United States and other countries. Where required, transfers are covered by
        safeguards such as the EU Standard Contractual Clauses.
      </p>
    ),
  },
  {
    id: "desktop",
    title: "Desktop app",
    body: (
      <p>
        The Vybe desktop app stores your videos and database on your own computer and sends AI requests directly to the providers
        using API keys you supply. In that mode we don’t receive your media; your use of those providers is governed by your
        agreement with them.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        Vybe isn’t for children under 13 (or under 16 in the EU/UK). We don’t knowingly collect their data — if you believe a
        child has signed up, contact us and we’ll delete the account.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If we make meaningful changes we’ll update the date above and, for significant changes, let you know by email or in the app
        before they take effect.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: <p>Questions or requests about your privacy: {mail}.</p>,
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what {LEGAL.operator} (“Vybe”, “we”, “us”) collects when you use our website, web app,
          desktop app and mobile app, how we use it, and the choices you have. The short version: we use your data to run the
          service you signed up for, we don’t sell it, and you can download or delete it yourself at any time.
        </p>
      }
      sections={sections}
    />
  );
}
