import signals from "../data/samples/signals.json";

type SignalCategory = "tech" | "vc";

type Signal = {
  id: string;
  title: string;
  source: string;
  url: string;
  published_at: string;
  category: SignalCategory;
  signal_type: string;
  summary: string;
  why_it_matters: string;
  tags: string[];
};

type Env = {
  ASSETS: Fetcher;
};

const allSignals = [...(signals as Signal[])].sort(
  (left, right) =>
    new Date(right.published_at).getTime() - new Date(left.published_at).getTime(),
);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function filterSignals(url: URL): Signal[] {
  const category = url.searchParams.get("category");
  const source = url.searchParams.get("source");
  const tag = url.searchParams.get("tag");

  return allSignals.filter((signal) => {
    if (category && signal.category !== category) {
      return false;
    }

    if (source && signal.source.toLowerCase() !== source.toLowerCase()) {
      return false;
    }

    if (tag && !signal.tags.some((item) => item.toLowerCase() === tag.toLowerCase())) {
      return false;
    }

    return true;
  });
}

function renderSignalPage(signal: Signal): string {
  const tagMarkup = signal.tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(signal.title)} | Silicon Sync</title>
    <meta
      name="description"
      content="${escapeHtml(signal.summary)}"
    />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="detail-body">
    <main class="detail-shell">
      <a class="back-link" href="/">Back to feed</a>
      <article class="detail-card">
        <div class="detail-meta">
          <span class="pill">${escapeHtml(signal.category)}</span>
          <span>${escapeHtml(signal.source)}</span>
          <span>${escapeHtml(new Date(signal.published_at).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }))} UTC</span>
        </div>
        <h1>${escapeHtml(signal.title)}</h1>
        <p class="detail-summary">${escapeHtml(signal.summary)}</p>
        <section>
          <h2>Why it matters</h2>
          <p>${escapeHtml(signal.why_it_matters)}</p>
        </section>
        <section>
          <h2>Signal type</h2>
          <p>${escapeHtml(signal.signal_type)}</p>
        </section>
        <section>
          <h2>Tags</h2>
          <div class="tag-row">${tagMarkup}</div>
        </section>
        <a class="source-link" href="${escapeHtml(signal.url)}" target="_blank" rel="noreferrer">Open source</a>
      </article>
    </main>
  </body>
</html>`;
}

export default {
  async fetch(request, env): Promise<Response> {
    const typedEnv = env as Env;
    const url = new URL(request.url);

    if (url.pathname === "/api/signals") {
      return json({
        items: filterSignals(url),
        total: filterSignals(url).length,
      });
    }

    if (url.pathname.startsWith("/api/signals/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/signals/", ""));
      const signal = allSignals.find((item) => item.id === id);

      if (!signal) {
        return json({ error: "Signal not found" }, 404);
      }

      return json(signal);
    }

    if (url.pathname.startsWith("/signals/")) {
      const id = decodeURIComponent(url.pathname.replace("/signals/", ""));
      const signal = allSignals.find((item) => item.id === id);

      if (!signal) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(renderSignalPage(signal), {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    return typedEnv.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
