import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
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
  const services = await prisma.service.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
  });
  return json({ services, planName: shop.planName });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });
  const form = await request.formData();
  const name = String(form.get("name") || "").trim();
  const durationRaw = Number(form.get("durationMinutes"));
  const priceRaw = Number(form.get("price"));
  const durationMinutes = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 30;
  const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;

  if (!name) return json({ error: "Service name is required." }, { status: 400 });

  await prisma.service.create({
    data: { shopId: shop.id, name, durationMinutes, price },
  });

  return json({ ok: true });
}

export default function Services() {
  const { services, planName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [price, setPrice] = useState("0");

  // Clear the form after a successful add, instead of leaving the
  // submitted values sitting there inviting an accidental re-submit.
  useEffect(() => {
    if (actionData && "ok" in actionData) {
      setName("");
      setDurationMinutes("30");
      setPrice("0");
    }
  }, [actionData]);

  return (
    <Page
      title="Services"
      subtitle={
        planName === "free"
          ? "Free plan: 1 active service. Upgrade to add more."
          : undefined
      }
    >
      <BlockStack gap="400">
        <Card>
          <Form method="post">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Add a service
              </Text>
              <InlineStack gap="300" wrap={false}>
                <TextField
                  label="Name"
                  name="name"
                  autoComplete="off"
                  requiredIndicator
                  value={name}
                  onChange={setName}
                />
                <TextField
                  label="Duration (minutes)"
                  name="durationMinutes"
                  type="number"
                  autoComplete="off"
                  value={durationMinutes}
                  onChange={setDurationMinutes}
                />
                <TextField
                  label="Price"
                  name="price"
                  type="number"
                  prefix="$"
                  autoComplete="off"
                  value={price}
                  onChange={setPrice}
                />
              </InlineStack>
              <InlineStack>
                <Button submit variant="primary" loading={busy}>
                  Add service
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <ResourceList
            resourceName={{ singular: "service", plural: "services" }}
            items={services}
            renderItem={(service) => (
              <ResourceItem id={service.id} onClick={() => {}}>
                <InlineStack align="space-between">
                  <Text as="span" fontWeight="semibold">
                    {service.name}
                  </Text>
                  <InlineStack gap="200">
                    <Badge>{`${service.durationMinutes} min`}</Badge>
                    <Badge tone="info">{`$${service.price}`}</Badge>
                  </InlineStack>
                </InlineStack>
              </ResourceItem>
            )}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
