import sourceRegistry from "../sources/registry.json";

type SourceCategory = "tech" | "vc";
type SourceChannel =
  | "community"
  | "launches"
  | "media"
  | "funding"
  | "vc_thesis"
  | "newsletter"
  | "podcast";
type DocumentType = "article" | "podcast";
type SourceParser =
  | "homepage_snapshot"
  | "feed_documents"
  | "a16z_podcast_shows"
  | "internal_article_links"
  | "hn_front_page";
type SourceClassification = "article" | "podcast" | "detect";

type Source = {
  id: string;
  name: string;
  category: SourceCategory;
  homepage: string;
  planned_access: string;
  status: string;
  content_channel: SourceChannel;
  parser?: SourceParser;
  classification?: SourceClassification;
  feed_url?: string;
  entry_limit?: number;
};

type Env = {
  SIGNAL_CACHE: KVNamespace;
  SYNC_TOKEN?: string;
};

type SourceLink = {
  url: string;
  text: string;
};

type StructuredDocument = {
  id: string;
  source_id: string;
  source_name: string;
  document_type: DocumentType;
  title: string;
  url: string;
  content: string;
  published_at: string | null;
  fetched_at: string;
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
  documents: StructuredDocument[];
  document_count: number;
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
  document_count: number;
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

type FeedEntry = {
  title: string;
  url: string;
  published_at: string | null;
  author: string | null;
  summary: string | null;
};

type PageDetails = {
  finalUrl: string;
  contentType: string;
  body: string;
  pageTitle: string | null;
  metaDescription: string | null;
  rawText: string;
};

const allSources = [...(sourceRegistry as Source[])].sort((left, right) =>
  left.name.localeCompare(right.name),
);
const ONE_DAY_SECONDS = 60 * 60 * 24;
const KV_RETENTION_SECONDS = ONE_DAY_SECONDS + 60 * 60;
const SYNC_BATCH_SIZE = 4;

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
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
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
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function extractTitle(markup: string): string | null {
  const title = extractTagContent(markup, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? decodeHtmlEntities(title) : null;
}

function extractMetaDescription(markup: string): string | null {
  const match = markup.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"]+)["'][^>]*>/i,
  )
    ?? markup.match(
      /<meta[^>]+content=["']([^"]+)["'][^>]+name=["']description["'][^>]*>/i,
    )
    ?? markup.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"]+)["'][^>]*>/i,
    );

  return match?.[1] ? decodeHtmlEntities(normalizeWhitespace(match[1])) : null;
}

function extractLinks(markup: string, contentType: string, baseUrl: string): SourceLink[] {
  const results: SourceLink[] = [];
  const seen = new Set<string>();

  if (contentType.includes("xml") || contentType.includes("rss") || contentType.includes("atom")) {
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

async function fetchMarkup(url: string): Promise<PageDetails> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "SiliconSyncBot/0.3 (+https://silicon.yulu34.top)",
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
  const finalUrl = response.url || url;
  const pageTitle = extractTitle(body);
  const metaDescription = extractMetaDescription(body);
  const rawText = stripTags(body).slice(0, 12000);

  return {
    finalUrl,
    contentType,
    body,
    pageTitle,
    metaDescription,
    rawText,
  };
}

function extractPublishedAt(markup: string): string | null {
  const match = markup.match(
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"]+)["'][^>]*>/i,
  )
    ?? markup.match(
      /<meta[^>]+name=["']parsely-pub-date["'][^>]+content=["']([^"]+)["'][^>]*>/i,
    )
    ?? markup.match(/<time[^>]+datetime=["']([^"]+)["'][^>]*>/i);

  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

function parseRssItems(xml: string): FeedEntry[] {
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)];

  return items.map((match) => {
    const block = match[0];
    const title = decodeHtmlEntities(extractTagContent(block, /<title>([\s\S]*?)<\/title>/i) ?? "");
    const url = decodeHtmlEntities(extractTagContent(block, /<link>([\s\S]*?)<\/link>/i) ?? "");
    const publishedAt = extractTagContent(block, /<pubDate>([\s\S]*?)<\/pubDate>/i);
    const author =
      decodeHtmlEntities(extractTagContent(block, /<dc:creator><!\[CDATA\[([\s\S]*?)\]\]><\/dc:creator>/i) ?? "")
      || decodeHtmlEntities(extractTagContent(block, /<author>([\s\S]*?)<\/author>/i) ?? "")
      || null;
    const summary =
      decodeHtmlEntities(stripTags(extractTagContent(block, /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ?? ""))
      || decodeHtmlEntities(stripTags(extractTagContent(block, /<description>([\s\S]*?)<\/description>/i) ?? ""))
      || null;

    return {
      title,
      url,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
      author: author || null,
      summary: summary || null,
    };
  }).filter((item) => item.url && item.title);
}

function detectDocumentType(page: PageDetails, entry: FeedEntry): DocumentType {
  const combined = `${entry.title} ${entry.summary ?? ""} ${page.body.slice(0, 3000)}`;
  return /twitter:player|embed\/podcast|podcast|listen now|episode/i.test(combined)
    ? "podcast"
    : "article";
}

function buildContent(documentType: DocumentType, page: PageDetails, entry: FeedEntry): string {
  const summary = page.metaDescription || entry.summary || "";
  const body = page.rawText;

  if (documentType === "podcast") {
    return normalizeWhitespace(`${summary}\n\n${body}`).slice(0, 14000);
  }

  return normalizeWhitespace(`${summary}\n\n${body}`).slice(0, 14000);
}

function isWithinLastDay(value: string | null, now = Date.now()): boolean {
  if (!value) {
    return false;
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return now - timestamp <= ONE_DAY_SECONDS * 1000;
}

function shouldIgnoreInternalLink(url: URL): boolean {
  const ignoredSegments = [
    "/about",
    "/privacy",
    "/terms",
    "/careers",
    "/jobs",
    "/contact",
    "/sitemap",
    "/podcasts",
    "/feed",
    "/tag/",
    "/tags/",
    "/category/",
    "/categories/",
    "/topics/",
    "/author/",
    "/authors/",
    "/newsletters",
  ];

  return ignoredSegments.some((segment) => url.pathname === segment || url.pathname.startsWith(segment));
}

function extractInternalArticleCandidates(source: Source, links: SourceLink[]): string[] {
  const baseOrigin = new URL(source.homepage).origin;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const link of links) {
    let absolute: URL;
    try {
      absolute = new URL(link.url);
    } catch {
      continue;
    }

    if (absolute.origin !== baseOrigin) {
      continue;
    }

    if (absolute.pathname === "/" || absolute.pathname.length < 6) {
      continue;
    }

    if (shouldIgnoreInternalLink(absolute)) {
      continue;
    }

    const normalized = absolute.toString().replace(/\/$/, "") || absolute.toString();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    candidates.push(normalized);

    if (candidates.length >= (source.entry_limit ?? 6) * 2) {
      break;
    }
  }

  return candidates;
}

async function buildDocumentFromEntry(source: Source, entry: FeedEntry): Promise<StructuredDocument | null> {
  try {
    const page = await fetchMarkup(entry.url);
    const detectedType = detectDocumentType(page, entry);

    if (source.classification === "article" && detectedType !== "article") {
      return null;
    }

    if (source.classification === "podcast" && detectedType !== "podcast") {
      return null;
    }

    const documentType = source.classification === "detect"
      ? detectedType
      : source.classification ?? detectedType;
    const title = page.pageTitle
      ? page.pageTitle.split(" - by ")[0]?.split(" | ")[0] ?? entry.title
      : entry.title;
    const content = buildContent(documentType, page, entry);
    const publishedAt = entry.published_at || extractPublishedAt(page.body);

    return {
      id: `${source.id}:${entry.url}`,
      source_id: source.id,
      source_name: source.name,
      document_type: documentType,
      title: normalizeWhitespace(title),
      url: page.finalUrl,
      content,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchDocumentsFromFeed(source: Source): Promise<StructuredDocument[]> {
  if (!source.feed_url) {
    return [];
  }

  const response = await fetch(source.feed_url, {
    headers: {
      "user-agent": "SiliconSyncBot/0.3 (+https://silicon.yulu34.top)",
      accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });

  const xml = await response.text();
  const entries = parseRssItems(xml).slice(0, source.entry_limit ?? 5);
  const documents = await Promise.all(entries.map((entry) => buildDocumentFromEntry(source, entry)));
  return documents.filter((item): item is StructuredDocument => Boolean(item));
}

async function fetchA16zPodcastShows(source: Source): Promise<StructuredDocument[]> {
  const page = await fetchMarkup(source.homepage);
  const showLinks = [...new Set(
    [...page.body.matchAll(/href=["'](\/podcasts\/[^/"']+\/?)["']/gi)].map((match) =>
      new URL(match[1] ?? "", source.homepage).toString(),
    ),
  )].slice(0, source.entry_limit ?? 6);

  const documents = await Promise.all(
    showLinks.map(async (url) => {
      const details = await fetchMarkup(url);
      const title = details.pageTitle?.split(" | ")[0] ?? url;
      const content = buildContent("podcast", details, {
        title,
        url,
        published_at: null,
        author: null,
        summary: details.metaDescription,
      });

      return {
        id: `${source.id}:${url}`,
        source_id: source.id,
        source_name: source.name,
        document_type: "podcast" as const,
        title,
        url: details.finalUrl,
        content,
        published_at: extractPublishedAt(details.body),
        fetched_at: new Date().toISOString(),
      };
    }),
  );

  return documents;
}

async function fetchInternalArticleLinks(source: Source): Promise<StructuredDocument[]> {
  const page = await fetchMarkup(source.homepage);
  const links = extractLinks(page.body, page.contentType, page.finalUrl);
  const candidates = extractInternalArticleCandidates(source, links).slice(0, source.entry_limit ?? 6);
  const documents = await Promise.all(
    candidates.map((url) =>
      buildDocumentFromEntry(source, {
        title: url,
        url,
        published_at: null,
        author: null,
        summary: null,
      }),
    ),
  );

  return documents.filter((item): item is StructuredDocument => Boolean(item));
}

async function fetchHackerNewsDocuments(source: Source): Promise<StructuredDocument[]> {
  const page = await fetchMarkup(source.homepage);
  const anchorPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const items: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();

  for (const match of page.body.matchAll(anchorPattern)) {
    const href = decodeHtmlEntities(normalizeWhitespace(match[1] ?? ""));
    const text = decodeHtmlEntities(stripTags(match[2] ?? "")).slice(0, 220);
    if (!href || !text) {
      continue;
    }

    let absolute = "";
    try {
      absolute = new URL(href, source.homepage).toString();
    } catch {
      continue;
    }

    if (absolute.startsWith("https://news.ycombinator.com/")) {
      continue;
    }

    if (seen.has(absolute)) {
      continue;
    }

    seen.add(absolute);
    items.push({ title: text, url: absolute });

    if (items.length >= (source.entry_limit ?? 10)) {
      break;
    }
  }

  const documents = await Promise.all(
    items.map((item) =>
      buildDocumentFromEntry(source, {
        title: item.title,
        url: item.url,
        published_at: null,
        author: null,
        summary: item.title,
      }),
    ),
  );

  return documents.filter((item): item is StructuredDocument => Boolean(item));
}

function filterFreshDocuments(documents: StructuredDocument[]): StructuredDocument[] {
  const now = Date.now();
  return documents.filter((item) => {
    if (isWithinLastDay(item.published_at, now)) {
      return true;
    }

    return isWithinLastDay(item.fetched_at, now);
  });
}

async function fetchSourceDocuments(source: Source): Promise<StructuredDocument[]> {
  if (source.parser === "feed_documents") {
    return filterFreshDocuments(await fetchDocumentsFromFeed(source));
  }

  if (source.parser === "a16z_podcast_shows") {
    return filterFreshDocuments(await fetchA16zPodcastShows(source));
  }

  if (source.parser === "internal_article_links") {
    return filterFreshDocuments(await fetchInternalArticleLinks(source));
  }

  if (source.parser === "hn_front_page") {
    return filterFreshDocuments(await fetchHackerNewsDocuments(source));
  }

  return [];
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

async function readSyncCursor(env: Env): Promise<number> {
  const raw = await env.SIGNAL_CACHE.get("sync:cursor");
  if (!raw) {
    return 0;
  }

  const value = Number(raw);
  return Number.isNaN(value) ? 0 : value;
}

async function writeSyncCursor(env: Env, value: number): Promise<void> {
  await env.SIGNAL_CACHE.put("sync:cursor", String(value), {
    expirationTtl: KV_RETENTION_SECONDS,
  });
}

async function fetchSourceSnapshot(source: Source): Promise<SourceSnapshot> {
  const page = await fetchMarkup(source.homepage);
  const links = extractLinks(page.body, page.contentType, page.finalUrl);
  const documents = await fetchSourceDocuments(source);

  return {
    source_id: source.id,
    source_name: source.name,
    category: source.category,
    content_channel: source.content_channel,
    requested_url: source.homepage,
    final_url: page.finalUrl,
    fetched_at: new Date().toISOString(),
    ok: true,
    status_code: 200,
    content_type: page.contentType,
    page_title: page.pageTitle,
    meta_description: page.metaDescription,
    raw_preview: page.rawText.slice(0, 4000),
    raw_length: page.body.length,
    link_count: links.length,
    links,
    etag: null,
    last_modified: null,
    documents,
    document_count: documents.length,
  };
}

async function syncSingleSource(env: Env, source: Source): Promise<SourceRunResult> {
  try {
    const snapshot = await fetchSourceSnapshot(source);
    await env.SIGNAL_CACHE.put(`source:${source.id}:latest`, JSON.stringify(snapshot), {
      expirationTtl: KV_RETENTION_SECONDS,
    });

    return {
      source_id: source.id,
      source_name: source.name,
      ok: snapshot.ok,
      status_code: snapshot.status_code,
      fetched_at: snapshot.fetched_at,
      final_url: snapshot.final_url,
      page_title: snapshot.page_title,
      link_count: snapshot.link_count,
      document_count: snapshot.document_count,
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
      document_count: 0,
      error: error instanceof Error ? error.message : "Unknown sync error",
    };
  }
}

function getBatchSources(cursor: number): Source[] {
  const start = cursor % allSources.length;
  const ordered = [...allSources.slice(start), ...allSources.slice(0, start)];
  return ordered.slice(0, SYNC_BATCH_SIZE);
}

async function syncAllSources(env: Env): Promise<SyncRun> {
  const startedAt = new Date().toISOString();
  const items: SourceRunResult[] = [];
  const cursor = await readSyncCursor(env);
  const batchSources = getBatchSources(cursor);

  for (const source of batchSources) {
    items.push(await syncSingleSource(env, source));
  }

  await writeSyncCursor(env, (cursor + batchSources.length) % allSources.length);

  const run: SyncRun = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    sources_total: batchSources.length,
    succeeded: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    items,
  };

  await env.SIGNAL_CACHE.put("run:latest", JSON.stringify(run), {
    expirationTtl: KV_RETENTION_SECONDS,
  });
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
            document_count: snapshots[index]?.document_count ?? 0,
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

async function handleSourceDocuments(env: Env, sourceId: string): Promise<Response> {
  const source = getSourceById(sourceId);
  if (!source) {
    return json({ error: "Source not found" }, 404);
  }

  const snapshot = await readSnapshot(env, sourceId);
  const items = snapshot?.documents ?? [];

  return json({
    source,
    fetched_at: snapshot?.fetched_at ?? null,
    items: items.map((item) => ({
      id: item.id,
      source_id: item.source_id,
      source_name: item.source_name,
      document_type: item.document_type,
      title: item.title,
      url: item.url,
      content: item.content,
      fetched_at: item.fetched_at,
    })),
    total: items.length,
  });
}

async function handleDocuments(env: Env, url: URL): Promise<Response> {
  const category = url.searchParams.get("category");
  const sourceId = url.searchParams.get("source");
  const type = url.searchParams.get("type");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 100);
  const snapshots = await Promise.all(
    allSources.map(async (source) => ({
      source,
      snapshot: await readSnapshot(env, source.id),
    })),
  );

  const items = snapshots
    .flatMap(({ source, snapshot }) =>
      (snapshot?.documents ?? []).map((item) => ({
        ...item,
        source_category: source.category,
      })),
    )
    .filter((item) => (!category || item.source_category === category))
    .filter((item) => (!sourceId || item.source_id === sourceId))
    .filter((item) => (!type || item.document_type === type))
    .sort((left, right) => new Date(right.fetched_at).getTime() - new Date(left.fetched_at).getTime())
    .slice(0, limit)
    .map(({ source_category: _sourceCategory, published_at: _publishedAt, ...item }) => item);

  return json({ items, total: items.length });
}

function overview() {
  return {
    service: "silicon-sync",
    mode: "agent-native source node",
    description:
      "Scheduled public-source snapshots plus structured article and podcast documents for Silicon Valley tech and VC intelligence.",
    sources_total: allSources.length,
    cron: "0 */3 * * *",
    endpoints: {
      sources: "/api/sources",
      source_detail: "/api/sources/:id",
      source_links: "/api/sources/:id/links",
      source_documents: "/api/sources/:id/documents",
      documents: "/api/documents?type=article|podcast",
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

    if (url.pathname === "/api/documents") {
      return handleDocuments(typedEnv, url);
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

    const sourceDocumentsMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/documents$/);
    if (sourceDocumentsMatch) {
      return handleSourceDocuments(typedEnv, decodeURIComponent(sourceDocumentsMatch[1]));
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
