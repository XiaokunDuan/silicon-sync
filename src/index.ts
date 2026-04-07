import sourceRegistry from "../sources/registry.json";

type SourceCategory = "tech" | "vc";
type SourceChannel =
  | "community"
  | "launches"
  | "media"
  | "funding"
  | "vc_thesis"
  | "newsletter";

type Source = {
  id: string;
  name: string;
  category: SourceCategory;
  homepage: string;
  planned_access: string;
  status: string;
  content_channel: SourceChannel;
};

type Env = {
  SIGNAL_CACHE: KVNamespace;
  SYNC_TOKEN?: string;
};

type SourceLink = {
  url: string;
  text: string;
};

type SourceSnapshot = {
  source_id: string;
  source_name: string;
  category: SourceCategory;
  content_channel: SourceChannel;
  requested_url: string;
  final_url: string;
  fetched_at: string;
  ok: boolean;
  status_code: number;
  content_type: string;
  page_title: string | null;
  meta_description: string | null;
  raw_preview: string;
  raw_length: number;
  link_count: number;
  links: SourceLink[];
  etag: string | null;
  last_modified: string | null;
};

type SourceRunResult = {
  source_id: string;
  source_name: string;
  ok: boolean;
  status_code: number;
  fetched_at: string;
  final_url: string;
  page_title: string | null;
  link_count: number;
  error?: string;
};

type SyncRun = {
  started_at: string;
  completed_at: string;
  sources_total: number;
  succeeded: number;
  failed: number;
  items: SourceRunResult[];
};

const allSources = [...(sourceRegistry as Source[])].sort((left, right) =>
  left.name.localeCompare(right.name),
);

function json(data: unknown, status = 200, maxAge = 60): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function extractTagContent(markup: string, pattern: RegExp): string | null {
  const match = markup.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  return normalizeWhitespace(match[1]);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractTitle(markup: string): string | null {
  const title = extractTagContent(markup, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? decodeHtmlEntities(title) : null;
}

function extractMetaDescription(markup: string): string | null {
  const match = markup.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  )
    ?? markup.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    );

  return match?.[1] ? decodeHtmlEntities(normalizeWhitespace(match[1])) : null;
}

function extractLinks(markup: string, contentType: string, baseUrl: string): SourceLink[] {
  const results: SourceLink[] = [];
  const seen = new Set<string>();

  if (contentType.includes("xml") || contentType.includes("rss")) {
    const linkPattern = /<link>(https?:\/\/[^<]+)<\/link>/gi;

    for (const match of markup.matchAll(linkPattern)) {
      const url = normalizeWhitespace(match[1] ?? "");
      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      results.push({ url, text: "" });
      if (results.length >= 40) {
        break;
      }
    }

    return results;
  }

  const anchorPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of markup.matchAll(anchorPattern)) {
    const href = decodeHtmlEntities(normalizeWhitespace(match[1] ?? ""));
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      continue;
    }

    let absoluteUrl = "";

    try {
      absoluteUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (
      absoluteUrl.includes("/vote?") ||
      absoluteUrl.includes("/hide?") ||
      absoluteUrl.includes("/login?") ||
      absoluteUrl.startsWith("https://news.ycombinator.com/vote?")
    ) {
      continue;
    }

    if (seen.has(absoluteUrl)) {
      continue;
    }

    const text = decodeHtmlEntities(stripTags(match[2] ?? "")).slice(0, 180);
    seen.add(absoluteUrl);
    results.push({ url: absoluteUrl, text });

    if (results.length >= 40) {
      break;
    }
  }

  return results;
}

function getSourceById(id: string): Source | undefined {
  return allSources.find((item) => item.id === id);
}

async function readSnapshot(env: Env, sourceId: string): Promise<SourceSnapshot | null> {
  const raw = await env.SIGNAL_CACHE.get(`source:${sourceId}:latest`);
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as SourceSnapshot;
}

async function readLatestRun(env: Env): Promise<SyncRun | null> {
  const raw = await env.SIGNAL_CACHE.get("run:latest");
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as SyncRun;
}

async function fetchSourceSnapshot(source: Source): Promise<SourceSnapshot> {
  const response = await fetch(source.homepage, {
    headers: {
      "user-agent": "SiliconSyncBot/0.2 (+https://silicon.yulu34.top)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "text/plain; charset=utf-8";
  const finalUrl = response.url || source.homepage;
  const pageTitle = extractTitle(body);
  const metaDescription = extractMetaDescription(body);
  const rawPreview = stripTags(body).slice(0, 4000);
  const links = extractLinks(body, contentType, finalUrl);

  return {
    source_id: source.id,
    source_name: source.name,
    category: source.category,
    content_channel: source.content_channel,
    requested_url: source.homepage,
    final_url: finalUrl,
    fetched_at: new Date().toISOString(),
    ok: response.ok,
    status_code: response.status,
    content_type: contentType,
    page_title: pageTitle,
    meta_description: metaDescription,
    raw_preview: rawPreview,
    raw_length: body.length,
    link_count: links.length,
    links,
    etag: response.headers.get("etag"),
    last_modified: response.headers.get("last-modified"),
  };
}

async function syncSingleSource(env: Env, source: Source): Promise<SourceRunResult> {
  try {
    const snapshot = await fetchSourceSnapshot(source);
    await env.SIGNAL_CACHE.put(`source:${source.id}:latest`, JSON.stringify(snapshot));

    return {
      source_id: source.id,
      source_name: source.name,
      ok: snapshot.ok,
      status_code: snapshot.status_code,
      fetched_at: snapshot.fetched_at,
      final_url: snapshot.final_url,
      page_title: snapshot.page_title,
      link_count: snapshot.link_count,
    };
  } catch (error) {
    return {
      source_id: source.id,
      source_name: source.name,
      ok: false,
      status_code: 0,
      fetched_at: new Date().toISOString(),
      final_url: source.homepage,
      page_title: null,
      link_count: 0,
      error: error instanceof Error ? error.message : "Unknown sync error",
    };
  }
}

async function syncAllSources(env: Env): Promise<SyncRun> {
  const startedAt = new Date().toISOString();
  const items: SourceRunResult[] = [];

  for (const source of allSources) {
    items.push(await syncSingleSource(env, source));
  }

  const run: SyncRun = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    sources_total: allSources.length,
    succeeded: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    items,
  };

  await env.SIGNAL_CACHE.put("run:latest", JSON.stringify(run));
  return run;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.SYNC_TOKEN) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  return header.slice("Bearer ".length) === env.SYNC_TOKEN;
}

async function handleSources(env: Env, url: URL): Promise<Response> {
  const category = url.searchParams.get("category");
  const snapshots = await Promise.all(allSources.map((source) => readSnapshot(env, source.id)));

  const items = allSources
    .map((source, index) => ({
      ...source,
      latest_snapshot: snapshots[index]
        ? {
            fetched_at: snapshots[index]?.fetched_at ?? null,
            ok: snapshots[index]?.ok ?? false,
            status_code: snapshots[index]?.status_code ?? 0,
            page_title: snapshots[index]?.page_title ?? null,
            final_url: snapshots[index]?.final_url ?? source.homepage,
            link_count: snapshots[index]?.link_count ?? 0,
          }
        : null,
    }))
    .filter((item) => !category || item.category === category);

  return json({ items, total: items.length });
}

async function handleSourceDetail(env: Env, sourceId: string): Promise<Response> {
  const source = getSourceById(sourceId);
  if (!source) {
    return json({ error: "Source not found" }, 404);
  }

  const snapshot = await readSnapshot(env, sourceId);

  return json({
    source,
    snapshot,
  });
}

async function handleSourceLinks(env: Env, sourceId: string): Promise<Response> {
  const source = getSourceById(sourceId);
  if (!source) {
    return json({ error: "Source not found" }, 404);
  }

  const snapshot = await readSnapshot(env, sourceId);
  if (!snapshot) {
    return json({ source, items: [], total: 0 });
  }

  return json({
    source,
    fetched_at: snapshot.fetched_at,
    items: snapshot.links,
    total: snapshot.links.length,
  });
}

function overview() {
  return {
    service: "silicon-sync",
    mode: "agent-native source node",
    description:
      "Scheduled public-source snapshots for Silicon Valley tech and VC intelligence. No frontend UI, only JSON endpoints.",
    sources_total: allSources.length,
    cron: "0 */3 * * *",
    endpoints: {
      sources: "/api/sources",
      source_detail: "/api/sources/:id",
      source_links: "/api/sources/:id/links",
      latest_run: "/api/runs/latest",
      manual_sync: "POST /api/sync",
    },
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const typedEnv = env as Env;
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json(overview(), 200, 30);
    }

    if (url.pathname === "/api/sources") {
      return handleSources(typedEnv, url);
    }

    if (url.pathname === "/api/runs/latest") {
      return json({
        item: await readLatestRun(typedEnv),
      });
    }

    if (url.pathname === "/api/sync") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      if (!isAuthorized(request, typedEnv)) {
        return json({ error: "Unauthorized" }, 401);
      }

      const run = await syncAllSources(typedEnv);
      return json(run, 200, 0);
    }

    const sourceLinksMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/links$/);
    if (sourceLinksMatch) {
      return handleSourceLinks(typedEnv, decodeURIComponent(sourceLinksMatch[1]));
    }

    const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
    if (sourceMatch) {
      return handleSourceDetail(typedEnv, decodeURIComponent(sourceMatch[1]));
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const typedEnv = env as Env;
    ctx.waitUntil(syncAllSources(typedEnv));
  },
} satisfies ExportedHandler<Env>;
