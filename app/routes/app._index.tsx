import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  Badge,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
  const weekEnd = new Date(dayStart.getTime() + 7 * 24 * 60 * 60_000);

  const [todayCount, weekCount, lastReconciliation] = await Promise.all([
    prisma.booking.count({
      where: { shopId: shop.id, startsAt: { gte: dayStart, lt: dayEnd } },
    }),
    prisma.booking.count({
      where: { shopId: shop.id, startsAt: { gte: dayStart, lt: weekEnd } },
    }),
    prisma.billingReconciliation.findFirst({
      where: { shopId: shop.id },
      orderBy: { ranAt: "desc" },
    }),
  ]);

  return json({ shop, todayCount, weekCount, lastReconciliation });
}

export default function Dashboard() {
  const { shop, todayCount, weekCount, lastReconciliation } =
    useLoaderData<typeof loader>();

  return (
    <Page title="Dashboard">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="100">
                <Text as="span" tone="subdued" variant="bodySm">
                  Today's bookings
                </Text>
                <Text as="span" variant="heading2xl">
                  {todayCount}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="span" tone="subdued" variant="bodySm">
                  Next 7 days
                </Text>
                <Text as="span" variant="heading2xl">
                  {weekCount}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="span" tone="subdued" variant="bodySm">
                  Plan
                </Text>
                <Text as="span" variant="heading2xl">
                  {shop.planName}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="span" tone="subdued" variant="bodySm">
                  Double-booking protection
                </Text>
                <Badge tone="success">Always on</Badge>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Reliability status
              </Text>
              <List>
                <List.Item>
                  No double-bookings — enforced at the database level on
                  every plan, including Free.
                </List.Item>
                <List.Item>
                  Storefront and POS read availability from the same query,
                  so a slot can't show open in one place and booked in the
                  other.
                </List.Item>
                <List.Item>
                  Billing reconciliation:{" "}
                  {lastReconciliation
                    ? `last run ${new Date(
                        lastReconciliation.ranAt,
                      ).toLocaleString()}, ${lastReconciliation.mismatches} mismatch(es)`
                    : "not yet run on this store (runs automatically once a paid plan is active)"}
                  .
                </List.Item>
                <List.Item>
                  The storefront widget script only loads on products
                  flagged as bookable services.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
