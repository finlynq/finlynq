/**
 * POST /api/billing/webhook — Stripe webhook handler (Session 2)
 *
 * Handles subscription lifecycle events from Stripe:
 *  - checkout.session.completed → activate plan
 *  - customer.subscription.updated → update plan
 *  - customer.subscription.deleted → revert to free
 *  - invoice.payment_failed → notify user
 *
 * Requires STRIPE_WEBHOOK_SECRET env var for signature verification.
 * Set STRIPE_SECRET_KEY env var for the Stripe client.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getDialect, db } from "@/db";
import * as pgSchema from "@/db/schema-pg";
import { getUserById, updateUserPlan } from "@/lib/auth/queries";
import { eq } from "drizzle-orm";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  return new Stripe(key);
}

function planFromLookupKey(key?: string | null): string {
  if (!key) return "pro";
  if (key.includes("premium")) return "premium";
  if (key.includes("pro")) return "pro";
  return "pro";
}

// Stripe sends the raw body for signature verification — must disable body parsing
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Billing is only available in managed mode." },
      { status: 403 }
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event: Stripe.Event;

  if (webhookSecret) {
    // Verify signature to ensure the request genuinely came from Stripe
    if (!sig) {
      return NextResponse.json(
        { error: "Missing Stripe-Signature header." },
        { status: 400 }
      );
    }
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signature verification failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } else {
    // No webhook secret configured — parse without verification (dev/test only)
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId ?? session.client_reference_id;
        if (!userId) break;

        const user = await getUserById(userId);
        if (!user) break;

        // Store Stripe customer ID
        const now = new Date().toISOString();
        if (session.customer) {
          await db
            .update(pgSchema.users)
            .set({ stripeCustomerId: session.customer as string, updatedAt: now })
            .where(eq(pgSchema.users.id, userId))
            .run();
        }

        // Activate plan
        await updateUserPlan(userId, "pro");
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        if (!customerId) break;

        const user = await db
          .select()
          .from(pgSchema.users)
          .where(eq(pgSchema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        const lookupKey = sub.items?.data?.[0]?.price?.lookup_key;
        const plan = planFromLookupKey(lookupKey);
        // Use trial_end (v22 API — current_period_end was removed)
        const expiresAt = sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : undefined;

        if (sub.status === "active" || sub.status === "trialing") {
          await updateUserPlan(user.id, plan, expiresAt);
        } else if (sub.status === "canceled" || sub.status === "unpaid") {
          await updateUserPlan(user.id, "free");
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        if (!customerId) break;

        const user = await db
          .select()
          .from(pgSchema.users)
          .where(eq(pgSchema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        await updateUserPlan(user.id, "free");
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id;
        if (!customerId) break;

        const user = await db
          .select()
          .from(pgSchema.users)
          .where(eq(pgSchema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        await db
          .insert(pgSchema.notifications)
          .values({
            userId: user.id,
            type: "billing",
            title: "Payment failed",
            message:
              "Your subscription payment failed. Please update your payment method to avoid service interruption.",
            read: 0,
            createdAt: new Date().toISOString(),
          })
          .run();
        break;
      }
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json(
      { error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
