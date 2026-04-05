/**
 * POST /api/billing/webhook — Stripe webhook handler (Phase 6: NS-36)
 *
 * Handles subscription lifecycle events from Stripe:
 *  - checkout.session.completed → activate plan
 *  - customer.subscription.updated → update plan
 *  - customer.subscription.deleted → revert to free
 *  - invoice.payment_failed → notify user
 *
 * In production, verify the Stripe-Signature header.
 * Set STRIPE_WEBHOOK_SECRET env var for verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { getUserById, updateUserPlan } from "@/lib/auth/queries";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

interface StripeEvent {
  type: string;
  data: {
    object: {
      customer?: string;
      subscription?: string;
      metadata?: Record<string, string>;
      status?: string;
      current_period_end?: number;
      items?: { data: Array<{ price: { lookup_key?: string } }> };
    };
  };
}

function planFromLookupKey(key?: string): string {
  if (!key) return "pro";
  if (key.includes("premium")) return "premium";
  if (key.includes("pro")) return "pro";
  return "pro";
}

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Billing is only available in managed mode." },
      { status: 403 }
    );
  }

  // In production: verify Stripe-Signature header
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const sig = request.headers.get("stripe-signature");
    if (!sig) {
      return NextResponse.json(
        { error: "Missing Stripe signature." },
        { status: 400 }
      );
    }
    // TODO: Use stripe.webhooks.constructEvent() for full verification
    // For now, we accept the event if the secret is configured and sig is present
  }

  try {
    const event: StripeEvent = await request.json();

    switch (event.type) {
      case "checkout.session.completed": {
        const { metadata, customer, subscription } = event.data.object;
        const userId = metadata?.userId;
        if (!userId) break;

        const user = await getUserById(userId);
        if (!user) break;

        // Store Stripe customer ID
        const now = new Date().toISOString();
        await db.update(schema.users)
          .set({
            // @ts-expect-error — customer is string|null from Stripe; Drizzle SQLite types are overly strict here
            stripeCustomerId: customer ?? undefined,
            updatedAt: now,
          })
          .where(eq(schema.users.id, userId))
          .run();

        // Activate plan (default to pro for checkout)
        await updateUserPlan(userId, "pro");
        break;
      }

      case "customer.subscription.updated": {
        const obj = event.data.object;
        const customerId = obj.customer;
        if (!customerId) break;

        // Find user by Stripe customer ID
        const user = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        const lookupKey = obj.items?.data?.[0]?.price?.lookup_key;
        const plan = planFromLookupKey(lookupKey);
        const expiresAt = obj.current_period_end
          ? new Date(obj.current_period_end * 1000).toISOString()
          : undefined;

        if (obj.status === "active" || obj.status === "trialing") {
          await updateUserPlan(user.id, plan, expiresAt);
        } else if (obj.status === "canceled" || obj.status === "unpaid") {
          await updateUserPlan(user.id, "free");
        }
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = event.data.object.customer;
        if (!customerId) break;

        const user = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        await updateUserPlan(user.id, "free");
        break;
      }

      case "invoice.payment_failed": {
        const customerId = event.data.object.customer;
        if (!customerId) break;

        const user = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.stripeCustomerId, customerId))
          .get();
        if (!user) break;

        // Create in-app notification about payment failure
        await db.insert(schema.notifications)
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
