import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { PLAN_ENTRY, PLAN_GROWTH } from "../plans";
import prisma from "../db.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, billing } = await authenticate.admin(request);

  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [PLAN_ENTRY, PLAN_GROWTH],
    isTest: true,
  });

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });

  return json({
    planName: shop.planName,
    hasActivePayment,
    activeSubscription: appSubscriptions[0] ?? null,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { billing } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "cancel") {
    const subscriptionId = String(form.get("subscriptionId") || "");
    if (subscriptionId) {
      await billing.cancel({ subscriptionId, isTest: true, prorate: true });
    }
    return redirect("/app/billing");
  }

  const plan = intent === "upgrade-growth" ? PLAN_GROWTH : PLAN_ENTRY;

  // Throws a redirect to Shopify's own charge-confirmation page; the
  // merchant lands back on /app/billing afterward regardless of
  // whether they approved or declined.
  return billing.request({
    plan,
    isTest: true,
    returnUrl: `${appUrl}/app/billing`,
  });
}

export default function Billing() {
  const { planName, hasActivePayment, activeSubscription } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <Page title="Billing">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Current plan
              </Text>
              <Badge tone={hasActivePayment ? "success" : undefined}>
                {activeSubscription ? activeSubscription.name : "Free"}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Plan on file: {planName}
            </Text>
            {hasActivePayment && activeSubscription && (
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <input
                  type="hidden"
                  name="subscriptionId"
                  value={activeSubscription.id}
                />
                <Button submit tone="critical" loading={busy}>
                  Cancel subscription
                </Button>
              </Form>
            )}
          </BlockStack>
        </Card>

        <InlineStack gap="400" wrap={false}>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Entry — $9/month
              </Text>
              <List>
                <List.Item>Multi-staff and multi-location</List.Item>
                <List.Item>Two-way calendar sync</List.Item>
                <List.Item>Custom questions</List.Item>
                <List.Item>Branding removed</List.Item>
              </List>
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade-entry" />
                <Button
                  submit
                  variant="primary"
                  loading={busy}
                  disabled={activeSubscription?.name === PLAN_ENTRY}
                >
                  {activeSubscription?.name === PLAN_ENTRY
                    ? "Current plan"
                    : "Upgrade to Entry"}
                </Button>
              </Form>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Growth — $19/month
              </Text>
              <List>
                <List.Item>Everything in Entry</List.Item>
                <List.Item>SMS/WhatsApp reminders</List.Item>
                <List.Item>Deposits</List.Item>
                <List.Item>Group &amp; subscription bookings</List.Item>
              </List>
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade-growth" />
                <Button
                  submit
                  variant="primary"
                  loading={busy}
                  disabled={activeSubscription?.name === PLAN_GROWTH}
                >
                  {activeSubscription?.name === PLAN_GROWTH
                    ? "Current plan"
                    : "Upgrade to Growth"}
                </Button>
              </Form>
            </BlockStack>
          </Card>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
