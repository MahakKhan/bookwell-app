import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Checkbox,
  Button,
  InlineStack,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });
  return json({ shop, appUrl });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  await prisma.shop.update({
    where: { shopDomain: session.shop },
    data: {
      smsEnabled: form.get("smsEnabled") === "true",
      twoWaySyncOn: form.get("twoWaySyncOn") === "true",
      widgetAccent: String(form.get("widgetAccent") || "#5b5bd6"),
      notifyFromEmail: String(form.get("notifyFromEmail") || "") || null,
      resendApiKey: String(form.get("resendApiKey") || "") || null,
      twilioAccountSid: String(form.get("twilioAccountSid") || "") || null,
      twilioAuthToken: String(form.get("twilioAuthToken") || "") || null,
      twilioFromNumber: String(form.get("twilioFromNumber") || "") || null,
    },
  });

  return json({ ok: true });
}

export default function Settings() {
  const { shop, appUrl } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [smsEnabled, setSmsEnabled] = useState(shop.smsEnabled);
  const [twoWaySyncOn, setTwoWaySyncOn] = useState(shop.twoWaySyncOn);
  const [notifyFromEmail, setNotifyFromEmail] = useState(shop.notifyFromEmail || "");
  const [resendApiKey, setResendApiKey] = useState(shop.resendApiKey || "");
  const [twilioAccountSid, setTwilioAccountSid] = useState(shop.twilioAccountSid || "");
  const [twilioAuthToken, setTwilioAuthToken] = useState(shop.twilioAuthToken || "");
  const [twilioFromNumber, setTwilioFromNumber] = useState(shop.twilioFromNumber || "");

  return (
    <Page title="Settings">
      <Card>
        <Form method="post">
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Widget &amp; notifications
            </Text>
            <Text as="p" tone="subdued">
              Changes here apply to the storefront widget immediately —
              no support ticket needed.
            </Text>

            <Checkbox
              label="SMS reminders (24 hours before a booking)"
              checked={smsEnabled}
              onChange={setSmsEnabled}
            />
            <Checkbox
              label="Two-way calendar sync (Google / Outlook / Apple)"
              checked={twoWaySyncOn}
              onChange={setTwoWaySyncOn}
            />

            <input type="hidden" name="smsEnabled" value={String(smsEnabled)} />
            <input
              type="hidden"
              name="twoWaySyncOn"
              value={String(twoWaySyncOn)}
            />
            <input
              type="hidden"
              name="widgetAccent"
              value={shop.widgetAccent}
            />

            <InlineStack>
              <Button submit variant="primary" loading={busy}>
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Google Calendar
          </Text>
          <Text as="p" tone="subdued">
            {shop.googleRefreshToken
              ? "Connected — new bookings, reschedules and cancellations sync automatically."
              : "Not connected. Needs this app's own Google OAuth client configured (GOOGLE_CLIENT_ID/SECRET) before you can connect — see the README."}
          </Text>
          <InlineStack>
            {/* target="_top" breaks out of the embedded admin iframe: Google's
                consent screen refuses to render inside one. */}
            <Button url={`${appUrl}/app/calendar/connect`} target="_top">
              {shop.googleRefreshToken ? "Reconnect" : "Connect Google Calendar"}
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <Form method="post">
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Email &amp; SMS providers
            </Text>
            <Text as="p" tone="subdued">
              Bring your own Resend (email) and Twilio (SMS) accounts.
              Confirmations only send once these are filled in — nothing
              is sent otherwise.
            </Text>

            <TextField
              label="Resend API key"
              autoComplete="off"
              value={resendApiKey}
              onChange={setResendApiKey}
              type="password"
            />
            <TextField
              label='"From" email address'
              autoComplete="off"
              value={notifyFromEmail}
              onChange={setNotifyFromEmail}
              placeholder="bookings@yourstore.com"
            />
            <TextField
              label="Twilio Account SID"
              autoComplete="off"
              value={twilioAccountSid}
              onChange={setTwilioAccountSid}
            />
            <TextField
              label="Twilio Auth Token"
              autoComplete="off"
              value={twilioAuthToken}
              onChange={setTwilioAuthToken}
              type="password"
            />
            <TextField
              label='Twilio "From" number'
              autoComplete="off"
              value={twilioFromNumber}
              onChange={setTwilioFromNumber}
              placeholder="+15551234567"
            />

            <input type="hidden" name="smsEnabled" value={String(smsEnabled)} />
            <input type="hidden" name="twoWaySyncOn" value={String(twoWaySyncOn)} />
            <input type="hidden" name="widgetAccent" value={shop.widgetAccent} />
            <input type="hidden" name="notifyFromEmail" value={notifyFromEmail} />
            <input type="hidden" name="resendApiKey" value={resendApiKey} />
            <input type="hidden" name="twilioAccountSid" value={twilioAccountSid} />
            <input type="hidden" name="twilioAuthToken" value={twilioAuthToken} />
            <input type="hidden" name="twilioFromNumber" value={twilioFromNumber} />

            <InlineStack>
              <Button submit variant="primary" loading={busy}>
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Card>
    </Page>
  );
}
