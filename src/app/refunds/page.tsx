import type { Metadata } from "next";
import { LegalPage, LEGAL, Bullets, A, type LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Refund Policy — Vybe",
  description: "How cancellations and refunds work for Vybe subscriptions.",
};

const mail = <A href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</A>;

const sections: LegalSection[] = [
  {
    id: "guarantee",
    title: "14-day money-back guarantee",
    body: (
      <p>
        If Vybe isn’t right for you, ask for a refund within 14 days of your first payment for a paid plan and we’ll refund it in
        full — no questions asked. This applies once per customer.
      </p>
    ),
  },
  {
    id: "renewals",
    title: "Renewals",
    body: (
      <p>
        Renewal payments (monthly or yearly) aren’t refunded, except where the law requires it. Forgot to cancel a yearly plan?
        Contact us within 7 days of the renewal and we’ll look at it case by case.
      </p>
    ),
  },
  {
    id: "cancel",
    title: "Cancelling",
    body: (
      <p>
        Cancel any time from the Billing page. Your plan stays active until the end of the period you’ve paid for, then your account
        moves to the Free plan. Remember that clips on the Free plan are deleted after 7 days — download anything you want to keep.
      </p>
    ),
  },
  {
    id: "eu",
    title: "EU & UK customers",
    body: (
      <p>
        You have a legal right to withdraw from a purchase within 14 days. Because Vybe gives you immediate access to paid features,
        you agree when subscribing that the service starts right away; our 14-day money-back guarantee above means you can still get a
        full refund on your first payment within that window.
      </p>
    ),
  },
  {
    id: "how",
    title: "How to request a refund",
    body: (
      <>
        <Bullets items={[
          <>Email {mail} from the address on your account, or reply to your receipt.</>,
          "Card payments are refunded by our payment provider (Paddle or Polar) to the original card, usually within 5–10 business days.",
          "Crypto payments are refunded in the same currency to an address you provide, minus network fees.",
        ]} />
      </>
    ),
  },
  {
    id: "abuse",
    title: "Exceptions",
    body: (
      <p>
        We may refuse refunds where an account was suspended for breaking our Terms, or where the guarantee is being abused (for
        example, repeated sign-ups to get refunds).
      </p>
    ),
  },
];

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refund Policy"
      intro={<p>We want you to pay for Vybe only if it’s worth it to you. Here’s how cancellations and refunds work.</p>}
      sections={sections}
    />
  );
}
