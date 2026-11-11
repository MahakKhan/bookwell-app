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
  const staff = await prisma.staffMember.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
  });
  return json({ staff, planName: shop.planName });
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
  const email = String(form.get("email") || "").trim();

  if (!name) return json({ error: "Name is required." }, { status: 400 });

  const staff = await prisma.staffMember.create({
    data: { shopId: shop.id, name, email },
  });

  // Default availability: Mon-Fri, 9am-5pm. Merchants adjust this from
  // the staff detail view (not built in this scaffold yet).
  await prisma.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5].map((weekday) => ({
      staffId: staff.id,
      weekday,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    })),
  });

  return json({ ok: true });
}

export default function Staff() {
  const { staff, planName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Clear the form after a successful add, instead of leaving the
  // submitted values sitting there inviting an accidental re-submit.
  useEffect(() => {
    if (actionData && "ok" in actionData) {
      setName("");
      setEmail("");
    }
  }, [actionData]);

  return (
    <Page
      title="Staff"
      subtitle={
        planName === "free"
          ? "Free plan: 1 team member. Upgrade to add more."
          : undefined
      }
    >
      <BlockStack gap="400">
        <Card>
          <Form method="post">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Add a team member
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
                  label="Email"
                  name="email"
                  autoComplete="off"
                  value={email}
                  onChange={setEmail}
                />
              </InlineStack>
              <InlineStack>
                <Button submit variant="primary" loading={busy}>
                  Add team member
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <ResourceList
            resourceName={{ singular: "team member", plural: "team members" }}
            items={staff}
            renderItem={(member) => (
              <ResourceItem id={member.id} onClick={() => {}}>
                <InlineStack align="space-between">
                  <Text as="span" fontWeight="semibold">
                    {member.name}
                  </Text>
                  <Badge tone={member.active ? "success" : undefined}>
                    {member.active ? "Active" : "Inactive"}
                  </Badge>
                </InlineStack>
              </ResourceItem>
            )}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
