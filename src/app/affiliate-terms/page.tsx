import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LEGAL, Bullets, Strong, A, type LegalSection } from "@/components/legal/LegalPage";
import { AFFILIATE } from "@/lib/affiliate";
import { AFFILIATE_TERMS_VERSION, SAFETY, blockedCountries } from "@/lib/affiliate-safety";

// Affiliate Program Terms. The numbers come from the live program settings
// (lib/affiliate.ts / lib/affiliate-safety.ts), so the page can't drift from
// what the code actually does. Bump AFFILIATE_TERMS_VERSION on material
// changes — affiliates must re-accept before their next payout.
//
// NOTE: written as a solid starting point, not legal advice. Have it reviewed
// for the country your business is registered in.

export const metadata: Metadata = {
  title: "Affiliate Program Terms — Vybe",
  description: "How the Vybe affiliate program works: commissions, payouts, verification and what isn't allowed.",
};

const mail = <A href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</A>;
const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

function sections(): LegalSection[] {
  const months = AFFILIATE.durationMonths > 0 ? `for the first ${AFFILIATE.durationMonths} months after they sign up` : "for as long as they stay a paying customer";
  const blocked = [...blockedCountries()];
  const names = (() => {
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      return blocked.map((c) => dn.of(c) ?? c);
    } catch { return blocked; }
  })();
  return [
    {
      id: "program",
      title: "The program",
      body: (
        <p>
          The Vybe affiliate program lets you earn a commission when people you refer pay for Vybe. By using your referral link or
          requesting a payout you agree to these terms, our <Link href="/terms" className="text-violet-300 hover:text-violet-200">Terms of Service</Link> and
          our <Link href="/privacy" className="text-violet-300 hover:text-violet-200">Privacy Policy</Link>. You take part as an independent
          contractor — not as our employee, agent or partner — and you can’t make promises or statements on {LEGAL.operator}’s behalf.
        </p>
      ),
    },
    {
      id: "commissions",
      title: "Commissions",
      body: (
        <Bullets items={[
          <>You earn <Strong>{AFFILIATE.commissionPct}%</Strong> of each payment a referred customer makes {months}.</>,
          <>Commissions are calculated on the amount actually paid, after discounts and excluding taxes, and are calculated and paid in <Strong>US dollars</Strong>. Payments made in other currencies may not qualify.</>,
          <>A customer counts as yours only if they create a new Vybe account through your link (the link is remembered for 30 days). We don’t credit existing customers, people who were already referred by someone else, or accounts you can’t legitimately refer — including your own.</>,
          <>Each commission is held for <Strong>{AFFILIATE.holdDays} days</Strong> before you can withdraw it, so refunds within our money-back window can be taken into account.</>,
          <>If a referred payment is refunded or charged back — even after the hold, and even after you’ve been paid — the commission is reversed and deducted from your future earnings. If a chargeback is later decided in our favour, the commission is restored.</>,
        ]} />
      ),
    },
    {
      id: "payouts",
      title: "Payouts",
      body: (
        <Bullets items={[
          <>You can request a payout once your available balance reaches <Strong>{usd(AFFILIATE.minPayoutCents)}</Strong>. We pay manually by PayPal, Wise or USDT (TRC-20), normally within 14 days of approval.</>,
          <>Before your first payout you must give us your full legal name, country and postal address, and accept these terms. You’re responsible for keeping your payout details correct; we aren’t responsible for money sent to details you provided.</>,
          <>Any transfer, conversion or network fees charged by your payout provider are yours.</>,
          <>We may require identity verification (an ID document and a selfie, through a verification provider) before paying — always for crypto payouts, once your lifetime payouts reach {usd(SAFETY.idCheckCents)}, and whenever we see signs of fraud. We won’t pay until it’s complete.</>,
          <>You’re responsible for any taxes on your commissions. We may ask for a tax form (for example a W-9 or W-8BEN) and may report payments to tax authorities where the law requires it.</>,
          <>We can’t make payouts to countries or people subject to sanctions{names.length ? <> — currently including {names.join(", ")}</> : null}, or where our payout providers don’t operate.</>,
        ]} />
      ),
    },
    {
      id: "not-allowed",
      title: "What isn’t allowed",
      body: (
        <>
          <p>Any of these can lead to reversed commissions, withheld payouts and removal from the program:</p>
          <Bullets items={[
            <>Referring yourself, your other accounts, or accounts created only to earn a commission or a discount.</>,
            <>Fake, automated or incentivised sign-ups (for example paying or rewarding people to subscribe and then refund).</>,
            <>Spam — unsolicited emails, DMs, comments or messages — or misleading claims about Vybe, its prices or its features.</>,
            <>Bidding on “Vybe” or similar terms in search ads, or using our name in domains, usernames or ads in a way that could be confused with us.</>,
            <>Coupon/deal sites listing codes we didn’t give you, cookie stuffing, or forcing your link onto people who didn’t click it.</>,
            <>Anything illegal, or anything that breaks a platform’s rules where you promote Vybe. Where the law requires it (for example the FTC rules in the US), you must clearly disclose that you earn a commission.</>,
          ]} />
        </>
      ),
    },
    {
      id: "fraud",
      title: "Fraud checks",
      body: (
        <p>
          To protect the program we look at signals such as the devices and networks used to sign up and request payouts (stored only as
          one-way hashes, never as raw IP addresses), email patterns, refund and chargeback rates, and the country payout requests come from.
          If we reasonably believe commissions were earned through fraud or a breach of these terms, we may reverse them, withhold payment
          while we investigate, and close your affiliate account.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes and ending",
      body: (
        <p>
          We may change the commission rate, the program or these terms. Changes apply to payments made after the change; for material
          changes we’ll ask you to accept the new terms before your next payout. Either side can stop participating at any time. If we end
          your participation for anything other than a breach of these terms, we’ll still pay your earned, valid commissions once they clear the hold.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Liability",
      body: (
        <p>
          The program is provided as is. To the extent the law allows, {LEGAL.operator}’s total liability to you in connection with the program
          is limited to the commissions you validly earned and haven’t been paid in the 12 months before the claim.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: <p>Questions about the program or a payout: {mail}. Terms version {AFFILIATE_TERMS_VERSION}.</p>,
    },
  ];
}

export default function AffiliateTermsPage() {
  return (
    <LegalPage
      title="Affiliate Program Terms"
      intro={<p>The rules for earning commissions by referring people to Vybe.</p>}
      sections={sections()}
    />
  );
}
