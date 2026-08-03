import { authenticate } from "../shopify.server";

const EMPTY = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const after = url.searchParams.get("after") ?? null;

    const res = await admin.graphql(
      `#graphql
      query ProductSearch($q: String, $after: String) {
        products(first: 25, query: $q, after: $after, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            featuredImage { url altText }
          }
        }
      }`,
      { variables: { q: q || null, after } }
    );

    const json = await res.json();
    return json.data?.products ?? EMPTY;
  } catch (e) {
    console.error("[CustomVogue] api/products error:", e instanceof Error ? e.message : JSON.stringify(e));
    return EMPTY;
  }
};
