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
type IngestMode = "rss_feed" | "xml_sitemap" | "official_api" | "page_data" | "homepage" | "manual_curated";
type SourceStability = "stable" | "experimental" | "manual_curated";
type SourceParser =
  | "homepage_snapshot"
  | "feed_documents"
  | "a16z_podcast_shows"
  | "internal_article_links"
  | "hn_front_page"
  | "sitemap_documents"
  | "nfx_documents"
  | "product_hunt_api"
  | "manual_curated";
type SourceClassification = "article" | "podcast" | "detect";

type Source = {
  id: string;
  name: string;
  category: SourceCategory;
  homepage: string;
  planned_access: string;
  status: string;
  content_channel: SourceChannel;
  ingest_mode?: IngestMode;
  enabled?: boolean;
  stability?: SourceStability;
  freshness_basis?: "published_at" | "fetched_at";
  parser?: SourceParser;
  classification?: SourceClassification;
  feed_url?: string;
  entry_limit?: number;
  sitemap_index_url?: string;
  sitemap_urls?: string[];
  sitemap_include_patterns?: string[];
  url_allowlist_patterns?: string[];
  credential_binding?: string;
  api_endpoint?: string;
  page_data_url?: string;
};

type Env = {
  SIGNAL_CACHE: KVNamespace;
  SYNC_TOKEN?: string;
  PRODUCT_HUNT_TOKEN?: string;
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

type SitemapEntry = {
  url: string;
  lastmod: string | null;
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

function html(markup: string, status = 200, maxAge = 120): Response {
  return new Response(markup, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      "user-agent": "PaloWireBot/0.3 (+https://silicon.yulu34.top)",
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

function parseSitemapEntries(xml: string): SitemapEntry[] {
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)];

  return entries.map((match) => {
    const block = match[1] ?? "";
    const url = extractTagContent(block, /<loc>([\s\S]*?)<\/loc>/i) ?? "";
    const lastmod = extractTagContent(block, /<lastmod>([\s\S]*?)<\/lastmod>/i);

    return {
      url: decodeHtmlEntities(url),
      lastmod: lastmod ? normalizeWhitespace(lastmod) : null,
    };
  }).filter((entry) => entry.url);
}

function parseSitemapIndex(xml: string): SitemapEntry[] {
  const entries = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)];

  return entries.map((match) => {
    const block = match[1] ?? "";
    const url = extractTagContent(block, /<loc>([\s\S]*?)<\/loc>/i) ?? "";
    const lastmod = extractTagContent(block, /<lastmod>([\s\S]*?)<\/lastmod>/i);

    return {
      url: decodeHtmlEntities(url),
      lastmod: lastmod ? normalizeWhitespace(lastmod) : null,
    };
  }).filter((entry) => entry.url);
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

function matchesAnyPattern(value: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) {
    return true;
  }

  return patterns.some((pattern) => value.includes(pattern));
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
      "user-agent": "PaloWireBot/0.3 (+https://silicon.yulu34.top)",
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

async function fetchXml(url: string, accept = "application/xml,text/xml;q=0.9,*/*;q=0.8"): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "PaloWireBot/0.3 (+https://silicon.yulu34.top)",
      accept,
    },
    redirect: "follow",
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });

  return response.text();
}

async function resolveSitemapUrls(source: Source): Promise<string[]> {
  if (source.sitemap_urls?.length) {
    return source.sitemap_urls;
  }

  if (!source.sitemap_index_url) {
    return [];
  }

  const xml = await fetchXml(source.sitemap_index_url);
  const entries = parseSitemapIndex(xml);

  return entries
    .map((entry) => entry.url)
    .filter((url) => matchesAnyPattern(url, source.sitemap_include_patterns));
}

async function fetchDocumentsFromSitemaps(source: Source): Promise<StructuredDocument[]> {
  const sitemapUrls = await resolveSitemapUrls(source);
  const sitemapXmls = await Promise.all(sitemapUrls.map((url) => fetchXml(url)));
  const recentEntries = sitemapXmls
    .flatMap((xml) => parseSitemapEntries(xml))
    .filter((entry) => matchesAnyPattern(entry.url, source.url_allowlist_patterns))
    .filter((entry) => isWithinLastDay(entry.lastmod))
    .sort((left, right) => new Date(right.lastmod ?? 0).getTime() - new Date(left.lastmod ?? 0).getTime())
    .slice(0, source.entry_limit ?? 5);

  const documents = await Promise.all(
    recentEntries.map((entry) =>
      buildDocumentFromEntry(source, {
        title: entry.url,
        url: entry.url,
        published_at: entry.lastmod,
        author: null,
        summary: null,
      }),
    ),
  );

  return documents.filter((item): item is StructuredDocument => Boolean(item));
}

function extractNfxBuildId(markup: string): string | null {
  const match = markup.match(/\/_next\/static\/([^/]+)\/_buildManifest\.js/);
  return match?.[1] ?? null;
}

async function fetchNfxDocuments(source: Source): Promise<StructuredDocument[]> {
  const sitemapXmls = await Promise.all((source.sitemap_urls ?? []).map((url) => fetchXml(url)));
  const recentEntries = sitemapXmls
    .flatMap((xml) => parseSitemapEntries(xml))
    .filter((entry) => matchesAnyPattern(entry.url, source.url_allowlist_patterns))
    .filter((entry) => isWithinLastDay(entry.lastmod))
    .sort((left, right) => new Date(right.lastmod ?? 0).getTime() - new Date(left.lastmod ?? 0).getTime())
    .slice(0, source.entry_limit ?? 5);

  let metadata = new Map<string, { title: string; summary: string | null }>();

  if (source.page_data_url) {
    try {
      const page = await fetchMarkup(source.page_data_url);
      const buildId = extractNfxBuildId(page.body);

      if (buildId) {
        const dataUrl = `https://www.nfx.com/_next/data/${buildId}/library.json`;
        const jsonText = await fetchXml(dataUrl, "application/json,text/plain;q=0.9,*/*;q=0.8");
        const payload = JSON.parse(jsonText) as {
          pageProps?: {
            categorizedPostSections?: Array<{
              posts?: Array<{
                title?: string;
                url?: string;
                shortDescription?: string;
              }>;
            }>;
          };
        };

        metadata = new Map(
          (payload.pageProps?.categorizedPostSections ?? [])
            .flatMap((section) => section.posts ?? [])
            .filter((post) => Boolean(post.url && post.title))
            .map((post) => [
              new URL(post.url ?? "", "https://nfx.com").toString().replace("https://www.nfx.com", "https://nfx.com"),
              {
                title: normalizeWhitespace(post.title ?? ""),
                summary: post.shortDescription ? normalizeWhitespace(decodeHtmlEntities(post.shortDescription)) : null,
              },
            ]),
        );
      }
    } catch {
      // Fall back to sitemap-only extraction if page-data probing fails.
    }
  }

  const documents = await Promise.all(
    recentEntries.map((entry) =>
      buildDocumentFromEntry(source, {
        title: metadata.get(entry.url)?.title ?? entry.url,
        url: entry.url,
        published_at: entry.lastmod,
        author: null,
        summary: metadata.get(entry.url)?.summary ?? null,
      }),
    ),
  );

  return documents.filter((item): item is StructuredDocument => Boolean(item));
}

async function fetchProductHuntDocuments(source: Source, env: Env): Promise<StructuredDocument[]> {
  if (!env.PRODUCT_HUNT_TOKEN) {
    throw new Error("Missing PRODUCT_HUNT_TOKEN");
  }

  const response = await fetch(source.api_endpoint ?? "https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PRODUCT_HUNT_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "PaloWireBot/0.3 (+https://silicon.yulu34.top)",
    },
    body: JSON.stringify({
      query: `query ProductHuntLatest($first: Int!) {
        posts(first: $first) {
          edges {
            node {
              id
              name
              tagline
              slug
              url
              website
              votesCount
              createdAt
            }
          }
        }
      }`,
      variables: {
        first: Math.max((source.entry_limit ?? 3) * 2, 6),
      },
    }),
  });
  const payload = await response.json() as {
    data?: {
      posts?: {
        edges?: Array<{
          node?: {
            id: string;
            name: string;
            tagline: string | null;
            slug: string | null;
            url: string;
            website: string | null;
            votesCount: number | null;
            createdAt: string;
          };
        }>;
      };
    };
  };

  const items = (payload.data?.posts?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter((node) => isWithinLastDay(node.createdAt))
    .slice(0, source.entry_limit ?? 3);

  return items.map((node) => ({
    id: `${source.id}:${node.id}`,
    source_id: source.id,
    source_name: source.name,
    document_type: "article" as const,
    title: normalizeWhitespace(node.name),
    url: node.url,
    content: normalizeWhitespace(
      `${node.tagline ?? ""}\n\nVotes: ${node.votesCount ?? 0}\nWebsite: ${node.website ?? "n/a"}\nProduct Hunt slug: ${node.slug ?? ""}`,
    ),
    published_at: new Date(node.createdAt).toISOString(),
    fetched_at: new Date().toISOString(),
  }));
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

  if (source.parser === "sitemap_documents") {
    return filterFreshDocuments(await fetchDocumentsFromSitemaps(source));
  }

  if (source.parser === "nfx_documents") {
    return filterFreshDocuments(await fetchNfxDocuments(source));
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
  if (source.parser === "manual_curated" || source.enabled === false) {
    return {
      source_id: source.id,
      source_name: source.name,
      category: source.category,
      content_channel: source.content_channel,
      requested_url: source.homepage,
      final_url: source.homepage,
      fetched_at: new Date().toISOString(),
      ok: true,
      status_code: 204,
      content_type: "text/plain; charset=utf-8",
      page_title: source.name,
      meta_description: "Manual curated source; auto sync disabled.",
      raw_preview: "",
      raw_length: 0,
      link_count: 0,
      links: [],
      etag: null,
      last_modified: null,
      documents: [],
      document_count: 0,
    };
  }

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
    const previousSnapshot = await readSnapshot(env, source.id);
    const nextSnapshot = await fetchSourceSnapshotWithEnv(source, env);
    let snapshot = nextSnapshot;

    if (nextSnapshot.document_count === 0 && (previousSnapshot?.document_count ?? 0) > 0) {
      snapshot = previousSnapshot as SourceSnapshot;
    }

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

async function fetchSourceSnapshotWithEnv(source: Source, env: Env): Promise<SourceSnapshot> {
  if (source.parser === "product_hunt_api") {
    const documents = filterFreshDocuments(await fetchProductHuntDocuments(source, env));
    return {
      source_id: source.id,
      source_name: source.name,
      category: source.category,
      content_channel: source.content_channel,
      requested_url: source.homepage,
      final_url: source.homepage,
      fetched_at: new Date().toISOString(),
      ok: true,
      status_code: 200,
      content_type: "application/json; charset=utf-8",
      page_title: source.name,
      meta_description: source.planned_access,
      raw_preview: "",
      raw_length: 0,
      link_count: documents.length,
      links: documents.map((document) => ({ url: document.url, text: document.title })),
      etag: null,
      last_modified: null,
      documents,
      document_count: documents.length,
    };
  }

  return fetchSourceSnapshot(source);
}

const syncableSources = allSources.filter((source) => source.enabled !== false && source.parser !== "manual_curated");

function getBatchSources(cursor: number): Source[] {
  if (syncableSources.length === 0) {
    return [];
  }

  const start = cursor % syncableSources.length;
  const ordered = [...syncableSources.slice(start), ...syncableSources.slice(0, start)];
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

  if (syncableSources.length > 0) {
    await writeSyncCursor(env, (cursor + batchSources.length) % syncableSources.length);
  }

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
      ingest_mode: source.ingest_mode ?? null,
      enabled: source.enabled !== false,
      stability: source.stability ?? null,
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
  const documents = (snapshot?.documents ?? []).map((item) => ({
    id: item.id,
    source_id: item.source_id,
    source_name: item.source_name,
    document_type: item.document_type,
    title: item.title,
    url: item.url,
    content: item.content,
    fetched_at: item.fetched_at,
  }));

  return json({
    source,
    fetched_at: snapshot?.fetched_at ?? null,
    items: documents,
    documents,
    total: documents.length,
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

  return json({ items, documents: items, total: items.length });
}

function overview() {
  return {
    service: "palo-wire",
    mode: "agent-native source node",
    description:
      "Scheduled public-source snapshots plus structured article and podcast documents for Silicon Valley tech and VC intelligence.",
    sources_total: allSources.length,
    syncable_sources_total: syncableSources.length,
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

function renderLanding(): string {
  const stableCount = allSources.filter((source) => source.stability === "stable").length;
  const experimentalCount = allSources.filter((source) => source.stability === "experimental").length;
  const feedsCount = allSources.filter((source) => source.ingest_mode === "rss_feed").length;
  const sitemapCount = allSources.filter((source) => source.ingest_mode === "xml_sitemap").length;
  const apiCount = allSources.filter((source) => source.ingest_mode === "official_api").length;
  const pageDataCount = allSources.filter((source) => source.ingest_mode === "page_data").length;

  const sourceCards = allSources
    .filter((source) => source.enabled !== false)
    .map((source) => {
      const label = `${source.category.toUpperCase()} · ${source.content_channel.replace(/_/g, " ")}`;
      const mode = source.ingest_mode?.replace(/_/g, " ") ?? "custom";
      const stability = source.stability ?? "stable";

      return `
        <article class="source-card">
          <div class="source-eyebrow">${escapeHtml(label)}</div>
          <h3>${escapeHtml(source.name)}</h3>
          <p>${escapeHtml(source.planned_access)}</p>
          <div class="source-meta">
            <span>${escapeHtml(mode)}</span>
            <span>${escapeHtml(stability)}</span>
          </div>
        </article>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Palo Wire</title>
    <meta
      name="description"
      content="Palo Wire is an AI-native signal desk for Silicon Valley tech and VC intelligence, built as a 24-hour rolling source node for agents."
    >
    <style>
      :root {
        --paper: #f5f1e8;
        --ink: #111111;
        --muted: #655f54;
        --rule: #d8d0c1;
        --accent: #8d1d1d;
        --panel: #fbf8f1;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          linear-gradient(to bottom, rgba(141, 29, 29, 0.05), transparent 140px),
          var(--paper);
        color: var(--ink);
        font-family: Georgia, "Times New Roman", Times, serif;
      }
      a { color: inherit; }
      .page {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px 20px 72px;
      }
      .masthead {
        border-top: 3px double var(--rule);
        border-bottom: 3px double var(--rule);
        padding: 12px 0 14px;
        text-align: center;
      }
      .masthead-top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
        color: var(--muted);
        font: 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .brand {
        margin: 0;
        font-size: clamp(46px, 8vw, 86px);
        line-height: 0.94;
        letter-spacing: -0.04em;
        font-weight: 700;
      }
      .subhead {
        max-width: 760px;
        margin: 10px auto 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.55;
      }
      .hero {
        display: grid;
        grid-template-columns: 1.45fr 0.9fr;
        gap: 28px;
        padding: 28px 0 32px;
        border-bottom: 1px solid var(--rule);
      }
      .hero-main {
        padding-right: 28px;
        border-right: 1px solid var(--rule);
      }
      .eyebrow {
        margin-bottom: 14px;
        color: var(--accent);
        font: 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .hero h2 {
        margin: 0;
        font-size: clamp(34px, 5vw, 64px);
        line-height: 0.98;
        letter-spacing: -0.03em;
      }
      .hero p {
        margin: 20px 0 0;
        font-size: 20px;
        line-height: 1.55;
      }
      .hero-side {
        display: grid;
        gap: 18px;
        align-content: start;
      }
      .dek, .source-card {
        background: var(--panel);
        border: 1px solid var(--rule);
      }
      .dek {
        padding: 18px;
      }
      .dek h3, .section h3, .source-card h3 {
        margin: 0 0 10px;
        font-size: 24px;
      }
      .dek p, .section p, .source-card p {
        margin: 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.65;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 26px;
      }
      .button {
        padding: 12px 16px;
        text-decoration: none;
        font: 13px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border: 1px solid var(--ink);
        background: var(--ink);
        color: white;
      }
      .button.secondary {
        background: transparent;
        color: var(--ink);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        border-bottom: 1px solid var(--rule);
      }
      .stat {
        padding: 20px 12px 22px;
        text-align: center;
        border-right: 1px solid var(--rule);
      }
      .stat:last-child { border-right: 0; }
      .stat strong {
        display: block;
        font-size: clamp(28px, 4vw, 42px);
        line-height: 1;
      }
      .stat span {
        display: block;
        margin-top: 8px;
        color: var(--muted);
        font: 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .grid {
        display: grid;
        grid-template-columns: 0.92fr 1.08fr;
        gap: 28px;
        padding-top: 28px;
      }
      .section {
        padding-top: 18px;
        border-top: 1px solid var(--rule);
      }
      .list {
        list-style: none;
        margin: 14px 0 0;
        padding: 0;
      }
      .list li {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 0;
        border-bottom: 1px solid var(--rule);
        font-size: 16px;
      }
      .list small {
        color: var(--muted);
        white-space: nowrap;
        font: 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .sources {
        margin-top: 30px;
        padding-top: 18px;
        border-top: 1px solid var(--rule);
      }
      .sources-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin-top: 18px;
      }
      .source-card {
        padding: 18px;
      }
      .source-card h3 { font-size: 22px; }
      .source-eyebrow, .source-meta {
        color: var(--muted);
        font: 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .source-eyebrow { margin-bottom: 10px; }
      .source-meta {
        display: flex;
        gap: 10px;
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid var(--rule);
      }
      .footer {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-top: 36px;
        padding-top: 16px;
        border-top: 3px double var(--rule);
        color: var(--muted);
        font-size: 14px;
      }
      @media (max-width: 980px) {
        .hero, .grid, .stats, .sources-grid {
          grid-template-columns: 1fr;
        }
        .hero-main, .stat {
          border-right: 0;
          padding-right: 0;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="masthead">
        <div class="masthead-top">
          <span>Silicon Valley Tech + VC Intelligence</span>
          <span>24-Hour Rolling Source Node</span>
          <span>Built For Agents</span>
        </div>
        <h1 class="brand">Palo Wire</h1>
        <p class="subhead">
          An AI-native signal desk that continuously collects early signals across product launches,
          developer communities, startup media, and venture capital writing, then republishes them in a
          lightweight format that agents can crawl and reason over.
        </p>
      </header>

      <section class="hero">
        <div class="hero-main">
          <div class="eyebrow">The Lead Story</div>
          <h2>Not a news site. A structured front page for AI systems watching Silicon Valley.</h2>
          <p>
            Palo Wire is designed to be read by models first. It crawls public sources, keeps only the
            latest 24 hours of material, and exposes a clean document layer so agents can summarize, rank,
            compare, and synthesize signals without re-crawling the open web every time.
          </p>
          <div class="actions">
            <a class="button" href="/api/documents">Open Documents API</a>
            <a class="button secondary" href="/api/sources">Browse Sources</a>
            <a class="button secondary" href="https://github.com/XiaokunDuan/palo-wire">View on GitHub</a>
          </div>
        </div>
        <aside class="hero-side">
          <div class="dek">
            <h3>What it does</h3>
            <p>
              Keeps a rolling intelligence layer for tech and VC sources, with official feeds, sitemaps,
              vendor APIs, and source-specific parsers replacing brittle homepage scraping.
            </p>
          </div>
          <div class="dek">
            <h3>What it is not</h3>
            <p>
              It is not a human reading product, a dashboard, or a summary engine. The landing page is the
              presentation layer; the core asset is the crawlable source node behind it.
            </p>
          </div>
        </aside>
      </section>

      <section class="stats">
        <div class="stat">
          <strong>${syncableSources.length}</strong>
          <span>Auto-Synced Sources</span>
        </div>
        <div class="stat">
          <strong>${stableCount}</strong>
          <span>Stable Pipelines</span>
        </div>
        <div class="stat">
          <strong>${experimentalCount}</strong>
          <span>Experimental Pipelines</span>
        </div>
        <div class="stat">
          <strong>24h</strong>
          <span>Retention Window</span>
        </div>
      </section>

      <section class="grid">
        <div class="section">
          <div class="eyebrow">The System</div>
          <h3>Built around official entry points whenever possible.</h3>
          <p>
            The node prefers feeds, sitemaps, page-data endpoints, and official APIs over HTML scraping.
            That keeps the signal layer lighter, cheaper, and more durable.
          </p>
          <ul class="list">
            <li><span>RSS feeds for newsletters and transcript-rich sources</span><small>${feedsCount} sources</small></li>
            <li><span>XML sitemaps for publisher and VC essay networks</span><small>${sitemapCount} sources</small></li>
            <li><span>Vendor APIs for protected platforms like Product Hunt</span><small>${apiCount} source</small></li>
            <li><span>Next.js page-data for modern content sites like NFX</span><small>${pageDataCount} source</small></li>
          </ul>
        </div>

        <div class="section">
          <div class="eyebrow">For AI Workflows</div>
          <h3>Optimized for downstream agents, not manual reading.</h3>
          <p>
            Every document is intentionally minimal. Title, content, URL, source identity, document type,
            and fetch time are enough for ranking, trend extraction, and synthesis.
          </p>
          <ul class="list">
            <li><span><a href="/api/documents">/api/documents</a> for cross-source retrieval</span><small>global feed</small></li>
            <li><span><a href="/api/sources">/api/sources</a> for source registry and health</span><small>registry</small></li>
            <li><span><a href="/api/runs/latest">/api/runs/latest</a> for sync visibility</span><small>ops</small></li>
            <li><span><a href="/api/sources/product-hunt/documents">Product Hunt</a> already runs on the official API</span><small>live now</small></li>
          </ul>
        </div>
      </section>

      <section class="sources">
        <div class="eyebrow">Tracked Sources</div>
        <h3 style="margin:0;font-size:36px;line-height:1.05;">A mix of community, launch, media, and investor surfaces.</h3>
        <p style="margin:10px 0 0;color:var(--muted);max-width:760px;line-height:1.65;">
          Palo Wire watches product launches, developer attention, startup reporting, newsletters,
          podcast networks, and VC writing. The goal is to capture early movement before it becomes consensus.
        </p>
        <div class="sources-grid">
          ${sourceCards}
        </div>
      </section>

      <footer class="footer">
        <span>Palo Wire</span>
        <span>Agent-native source node for Silicon Valley intelligence</span>
      </footer>
    </div>
  </body>
</html>`;
}

export default {
  async fetch(request, env): Promise<Response> {
    const typedEnv = env as Env;
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return html(renderLanding(), 200, 120);
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
