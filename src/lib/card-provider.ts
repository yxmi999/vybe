// Which Merchant-of-Record handles NEW card subscriptions.
//
//   CARD_PROVIDER=paddle | polar   — explicit choice (must be configured)
//   CARD_PROVIDER=off              — no new card checkouts (e.g. live keys staged, account not approved yet)
//   unset                          — Polar if configured, else Paddle (legacy default)
//
// Only new checkouts follow this. Existing subscribers keep their provider:
// the portal and both webhooks stay live as long as that provider's keys are
// set, so you can switch providers without stranding anyone.
import { paddleBrandedEnabled, paddleCheckoutReady } from "./paddle";
import { polarBrandedEnabled, polarEnabled } from "./polar";

export type CardProvider = "polar" | "paddle";

export function cardProvider(): CardProvider | null {
  const want = (process.env.CARD_PROVIDER ?? "").trim().toLowerCase();
  if (want === "off" || want === "none") return null;
  if (want === "paddle") return paddleCheckoutReady() ? "paddle" : null;
  if (want === "polar") return polarEnabled() ? "polar" : null;
  if (polarEnabled()) return "polar";
  if (paddleCheckoutReady()) return "paddle";
  return null;
}

export function cardBrandedEnabled(): boolean {
  const p = cardProvider();
  return p === "polar" ? polarBrandedEnabled() : p === "paddle" ? paddleBrandedEnabled() : false;
}
