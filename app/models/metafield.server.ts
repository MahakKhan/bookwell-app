type Admin = { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

// The storefront block only renders on products that carry the
// bookwell.service_id metafield. Doing this from the admin means the
// merchant just picks a product instead of hand-editing metafields.

export async function ensureMetafieldDefinition(admin: Admin) {
  try {
    await admin.graphql(
      `#graphql
      mutation Def($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          userErrors { code message }
        }
      }`,
      {
        variables: {
          definition: {
            name: "Bookwell service",
            namespace: "bookwell",
            key: "service_id",
            type: "single_line_text_field",
            ownerType: "PRODUCT",
            access: { storefront: "PUBLIC_READ" },
          },
        },
      },
    );
  } catch {
    // Already exists (or not permitted): the metafield still works in Liquid.
  }
}

export async function linkProductToService(admin: Admin, productId: string, serviceId: string) {
  await ensureMetafieldDefinition(admin);
  const res = await admin.graphql(
    `#graphql
    mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: "bookwell",
            key: "service_id",
            type: "single_line_text_field",
            value: serviceId,
          },
        ],
      },
    },
  );
  const data = await res.json();
  const errors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
}

export async function unlinkProduct(admin: Admin, productId: string) {
  try {
    await admin.graphql(
      `#graphql
      mutation Del($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          userErrors { message }
        }
      }`,
      { variables: { metafields: [{ ownerId: productId, namespace: "bookwell", key: "service_id" }] } },
    );
  } catch {
    // Best effort.
  }
}
