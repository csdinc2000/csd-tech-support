import type Stripe from "stripe";
import { getUncachableStripeClient } from "../server/stripeClient";

type PlanSeed = {
  name: string;
  description: string;
  monthlyAmount: number;
  features: string[];
  highlighted?: boolean;
};

const PLANS: PlanSeed[] = [
  {
    name: "Starter",
    description: "Essentials for small teams getting started with RMM.",
    monthlyAmount: 4900,
    features: [
      "Up to 25 managed devices",
      "Helpdesk ticketing",
      "Basic monitoring & alerts",
      "Email support",
    ],
  },
  {
    name: "Pro",
    description: "Advanced monitoring, automation, and remote access for growing MSPs.",
    monthlyAmount: 14900,
    highlighted: true,
    features: [
      "Up to 250 managed devices",
      "Remote access (MeshCentral)",
      "Patch management & automation",
      "CRM module",
      "Priority email & chat support",
    ],
  },
  {
    name: "Enterprise",
    description: "Unlimited scale with premium support and onboarding.",
    monthlyAmount: 49900,
    features: [
      "Unlimited managed devices",
      "Multi-tenant client management",
      "Emergency SMS/Email alerts",
      "Dedicated success manager",
      "24/7 priority support",
    ],
  },
];

async function findProductByName(
  stripe: Stripe,
  name: string
): Promise<Stripe.Product | null> {
  try {
    const result = await stripe.products.search({ query: `name:'${name}'` });
    return result.data[0] ?? null;
  } catch {
    const list = await stripe.products.list({ limit: 100, active: true });
    return list.data.find((p) => p.name === name) ?? null;
  }
}

async function ensurePlan(stripe: Stripe, plan: PlanSeed): Promise<void> {
  const features = plan.features.join("|");
  const metadata: Record<string, string> = {
    features,
    highlighted: plan.highlighted ? "true" : "false",
  };

  let product = await findProductByName(stripe, plan.name);
  if (!product) {
    product = await stripe.products.create({
      name: plan.name,
      description: plan.description,
      metadata,
    });
    console.log(`Created product ${plan.name}: ${product.id}`);
  } else {
    await stripe.products.update(product.id, {
      description: plan.description,
      metadata,
      active: true,
    });
    console.log(`Updated product ${plan.name}: ${product.id}`);
  }

  const existingPrices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const matchingPrice = existingPrices.data.find(
    (p) =>
      p.unit_amount === plan.monthlyAmount &&
      p.currency === "usd" &&
      p.recurring?.interval === "month"
  );

  if (matchingPrice) {
    console.log(
      `  Price exists for ${plan.name}: ${matchingPrice.id} ($${(plan.monthlyAmount / 100).toFixed(2)}/mo)`
    );
  } else {
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.monthlyAmount,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(
      `  Created price for ${plan.name}: ${price.id} ($${(plan.monthlyAmount / 100).toFixed(2)}/mo)`
    );
  }
}

async function main() {
  const stripe = await getUncachableStripeClient();
  for (const plan of PLANS) {
    await ensurePlan(stripe, plan);
  }
  console.log("\nSeed complete. Webhooks will sync products/prices into the local stripe schema.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
