import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LEGAL, Bullets, Strong, A, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — Vybe",
  description: "The rules for using Vybe, including content rights, billing and acceptable use.",
};

const mail = <A href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</A>;

const sections: LegalSection[] = [
  {
    id: "service",
    title: "The service",
    body: (
      <p>
        Vybe helps you turn long videos into short clips and publish them. It includes importing and uploading video,
        finding highlights, AI-assisted editing, rendering, scheduling and publishing to connected social accounts, Auto-Pilot,
        Auto-Respond and analytics. Features may change as we improve the product.
      </p>
    ),
  },
  {
    id: "beta",
    title: "Public beta",
    body: (
      <>
        <p>
          Vybe is currently in public beta. It’s fully usable, but we release updates often: features may change, move or be
          removed, and you may run into bugs. Keep your own copies of anything important — download finished clips you want to keep.
        </p>
        <p>
          If you subscribe during the beta, you keep the price you signed up at after launch for as long as your subscription stays
          active without a break. Cancelling, or letting a payment lapse, ends the beta price. Feedback you send us may be used to
          improve Vybe, with no obligation to you.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Your account",
    body: (
      <Bullets items={[
        "You must be at least 13 years old (16 in the EU/UK), and old enough to form a binding contract where you live — or have a parent or guardian’s permission.",
        "Give accurate information and keep your login secure. You’re responsible for activity on your account.",
        "Tell us right away if you suspect unauthorized access.",
        "Don’t create multiple free accounts to get around plan limits.",
      ]} />
    ),
  },
  {
    id: "content-rights",
    title: "Content you clip and post",
    body: (
      <>
        <p>
          <Strong>You’re responsible for having the rights to everything you import, edit and publish.</Strong> Only clip videos you
          own, videos you have permission to use (for example, a creator who allows clipping or a clipping campaign you’ve joined),
          or uses allowed by law such as fair use. Respect the creators you clip — credit them where expected and follow their rules.
        </p>
        <p>
          Importing a link into Vybe doesn’t give you any rights to that video. You must also follow the rules of the platform the
          video comes from and the one you post to, including their policies on reused content, music and AI-generated content
          disclosure.
        </p>
      </>
    ),
  },
  {
    id: "ownership",
    title: "Ownership & license",
    body: (
      <>
        <p>
          You keep all rights to your content. You give us a limited license to host, copy, process (including with AI providers),
          render and transmit it — only to provide the service to you, and only for as long as needed.
        </p>
        <p>
          Vybe’s software, design, branding and editing styles we provide belong to us. You may use the output you create with Vybe
          for any lawful purpose, including commercially. Editing styles you save are yours.
        </p>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI features",
    body: (
      <p>
        AI suggestions — edits, captions, transcripts, titles, covers, virality scores, highlight picks — are generated
        automatically and can be wrong. They aren’t professional advice and don’t guarantee views or earnings. Review everything
        before you publish; you’re responsible for what goes out on your accounts.
      </p>
    ),
  },
  {
    id: "connected",
    title: "Connected social accounts",
    body: (
      <>
        <p>
          When you connect an account you authorize Vybe to act on it for the features you enable — publishing, reading analytics
          and replying to comments. You can disconnect at any time. Your use of each platform remains subject to its own terms:
        </p>
        <Bullets items={[
          <A key="yt" href="https://www.youtube.com/t/terms">YouTube Terms of Service</A>,
          <A key="tt" href="https://www.tiktok.com/legal/page/global/terms-of-service/en">TikTok Terms of Service</A>,
          <A key="ig" href="https://help.instagram.com/581066165581870">Instagram Terms of Use</A>,
          <A key="x" href="https://x.com/en/tos">X Terms of Service</A>,
        ]} />
        <p>
          Posts can fail because of platform outages, rate limits, expired permissions or policy changes outside our control.
          Failed posts are flagged in your dashboard so you can retry.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>Don’t use Vybe to:</p>
        <Bullets items={[
          "Infringe copyright, trademark, privacy or publicity rights, or repost others’ content without permission.",
          "Publish illegal, hateful, harassing, sexually exploitative or violent content, or anything involving minors inappropriately.",
          "Mislead people — impersonation, deceptive deepfakes, fake engagement or spam.",
          "Break the rules of any connected platform or get around its limits.",
          "Overload, scrape, reverse engineer, resell or interfere with the service, or bypass plan limits or watermarks.",
          "Distribute malware or try to access accounts or systems that aren’t yours.",
        ]} />
        <p>We may remove content or suspend accounts that break these rules.</p>
      </>
    ),
  },
  {
    id: "copyright",
    title: "Copyright complaints",
    body: (
      <>
        <p>
          If you believe content processed or stored on Vybe infringes your copyright, email {mail} with: your contact details,
          the work you own, where the infringing material is, a statement that you believe in good faith the use isn’t authorized,
          and a statement under penalty of perjury that your notice is accurate and you’re the owner or authorized to act for them.
        </p>
        <p>
          We’ll remove or disable the material promptly and notify the user, who may send a counter-notice. We terminate accounts of
          repeat infringers.
        </p>
      </>
    ),
  },
  {
    id: "billing",
    title: "Plans, billing & cancellation",
    body: (
      <>
        <Bullets items={[
          "The Free plan has usage limits, a watermark on exports, and automatic deletion of clips after 7 days.",
          "Paid plans are billed monthly or yearly in advance and renew automatically until you cancel.",
          "Card payments are processed by Paddle or Polar as merchant of record — they handle the charge, invoices and sales tax. Crypto payments are processed by NOWPayments.",
          "You can cancel any time; you keep paid features until the end of the period you’ve paid for.",
          "We may change prices with at least 30 days’ notice. Changes apply from your next renewal.",
          "If a payment fails we may move your account to the Free plan.",
        ]} />
        <p>Refunds are covered by our <Link href="/refunds" className="text-violet-300/90 hover:text-violet-200 underline underline-offset-2 decoration-violet-400/40">Refund Policy</Link>.</p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability & changes",
    body: (
      <p>
        We work to keep Vybe running smoothly but can’t promise it will always be available or error-free. We may change, add or
        remove features. If we discontinue a paid feature you rely on, we’ll give reasonable notice.
      </p>
    ),
  },
  {
    id: "termination",
    title: "Ending your account",
    body: (
      <p>
        You can stop using Vybe and delete your account at any time from the <Link href="/account" className="text-violet-300/90 hover:text-violet-200 underline underline-offset-2 decoration-violet-400/40">Account &amp; data</Link> page. We may suspend or close accounts that break these
        Terms, create legal risk or harm other users — with notice where reasonable. After closure your content is deleted as
        described in our <Link href="/privacy" className="text-violet-300/90 hover:text-violet-200 underline underline-offset-2 decoration-violet-400/40">Privacy Policy</Link>.
      </p>
    ),
  },
  {
    id: "warranty",
    title: "Disclaimer",
    body: (
      <p>
        Vybe is provided “as is” and “as available”. To the extent the law allows, we disclaim all warranties, including
        merchantability, fitness for a particular purpose and non-infringement. Nothing here limits rights you have under consumer
        protection law that can’t be waived.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the extent the law allows, we aren’t liable for indirect, incidental, special or consequential damages, or for lost
        profits, revenue, views or data. Our total liability for any claim is limited to the amount you paid us in the 12 months
        before it arose, or $50 if you haven’t paid anything.
      </p>
    ),
  },
  {
    id: "indemnity",
    title: "Indemnity",
    body: (
      <p>
        If someone brings a claim against us because of content you published through Vybe or your breach of these Terms, you agree
        to cover the reasonable costs and damages that result.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law & disputes",
    body: (
      <p>
        These Terms are governed by the laws of the country where {LEGAL.operator} is established, without regard to conflict-of-law
        rules. If you’re a consumer, you also keep the protection of the mandatory laws of the country you live in. Before going to
        court, please contact us — most issues can be solved quickly by email.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <p>
        We may update these Terms. We’ll change the date above and notify you of material changes by email or in the app before they
        take effect. Continuing to use Vybe after that means you accept the new Terms.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: <p>Questions about these Terms: {mail}.</p>,
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These Terms are an agreement between you and {LEGAL.operator} (“Vybe”, “we”, “us”) for using our website, web app,
          desktop app and mobile app. By creating an account or using Vybe you agree to them — please read them, especially the
          section on content you clip and post.
        </p>
      }
      sections={sections}
    />
  );
}
