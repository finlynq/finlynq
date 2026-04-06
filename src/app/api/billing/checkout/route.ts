/**
 * POST /api/billing/checkout — Create a Stripe Checkout session (Session 2)
 *
 * Creates a checkout session for the logged-in user. New subscriptions
 * include a 14-day free trial via trial_period_days.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY      — Stripe secret API key
 *   NEXT_PUBLIC_APP_URL    — Base URL for success/cancel redirects
 *
 * Optional env vars:
 *   STRIPE_PRO_PRICE_ID    — Stripe Price ID for the Pro plan
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getDialect } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUserById } from "@/lib/auth/queries";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  return new Stripe(key);
}

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Billing is only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const user = await getUserById(auth.context.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) {
    return NextResponse.json(
      { error: "Billing is not configured. Contact support." },
      { status: 503 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    const stripe = getStripe();

    // Include 14-day trial only for new/trial users, not existing paid users
    const subscriptionData =
      user.plan === "free" || user.plan === "trial"
        ? { trial_period_days: 14, metadata: { userId: user.id } }
        : { metadata: { userId: user.id } };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: subscriptionData,
      metadata: { userId: user.id },
      success_url: `${appUrl}/settings?billing=success`,
      cancel_url: `${appUrl}/settings?billing=cancel`,
      client_reference_id: user.id,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : {}),
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create checkout session: ${message}` },
      { status: 500 }
    );
  }
}
