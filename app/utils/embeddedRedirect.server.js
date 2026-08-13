import { redirect } from "react-router";

// React Router's own single-fetch params. They belong to the data request that
// is being answered, not to the page we are sending the merchant to.
const ROUTER_PARAMS = ["_routes", "_data", "index"];

// Redirects inside an embedded app must carry Shopify's query params — shop,
// host, embedded and id_token — through to the next request.
//
// A bare redirect("/app/onboarding") arrives with none of them, so
// authenticate.admin() on that request cannot identify the shop and falls back
// to /auth/login. Inside the admin iframe that renders a "Shop domain" form,
// and submitting it starts an OAuth flow the iframe can't complete: the
// merchant sees a blank frame. Same rule as routes/_index/route.jsx, which
// hands the install params on with `/app?${url.searchParams}`.
export function redirectWithShopParams(request, pathname) {
  const params = new URLSearchParams(new URL(request.url).search);
  ROUTER_PARAMS.forEach((p) => params.delete(p));
  const qs = params.toString();
  return redirect(qs ? `${pathname}?${qs}` : pathname);
}
