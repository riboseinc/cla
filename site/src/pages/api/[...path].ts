// Server endpoint: EVERYTHING under /api/* delegates to the Hono app
// with the /api prefix stripped — the protocol surface (and its spec
// suite) keeps its original routes, unchanged.
export const prerender = false;



export const ALL: import("astro").APIRoute = async (context) => {
  // never reached in production (the wrapper worker handles /api/*);
  // kept so the route exists if the site is ever run standalone.
  return new Response(JSON.stringify({ error: "api served by the wrapper worker" }), { status: 501 });
};
