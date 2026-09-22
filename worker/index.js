export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!env.API_ORIGIN) {
        return Response.json({ error: 'API_ORIGIN is not configured.' }, { status: 503 });
      }

      const apiOrigin = new URL(env.API_ORIGIN);
      const apiUrl = new URL(url.pathname + url.search, apiOrigin);
      return fetch(new Request(apiUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
