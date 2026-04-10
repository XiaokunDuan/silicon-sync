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
  content_html?: string | null;
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

function stripScriptsAndStyles(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
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

function unwrapCdata(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1");
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

function cleanDocumentTitle(title: string): string {
  return normalizeWhitespace(
    unwrapCdata(decodeHtmlEntities(title))
      .replace(/\s+\|\s+(TechCrunch|Andreessen Horowitz|a16z|Sequoia Capital|Lightspeed Venture Partners)$/i, "")
      .replace(/\s+-\s+Lightspeed Venture Partners$/i, "")
      .replace(/\s+-\s+Latent\.Space$/i, "")
      .replace(/\s+\|\s+Y Combinator$/i, ""),
  );
}

function extractPrimaryContent(markup: string): string {
  const cleaned = stripScriptsAndStyles(markup);
  const candidates: string[] = [];
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<(section|div)\b[^>]+(?:class|id)=["'][^"']*(?:article|content|body|entry|story|post|main)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const block = stripTags(match[2] ?? match[1] ?? "");
      if (block.length > 200) {
        candidates.push(block);
      }
    }
  }

  const scored = candidates
    .map((value) => {
      const noiseMatches = value.match(
        /\b(menu|portfolio team|focus areas|about|team|companies|products|content|sign in|subscribe|open menu|newsletters|latest news)\b/gi,
      ) ?? [];
      return { value, score: value.length - noiseMatches.length * 80 };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.value ?? "";
}

function cleanContentText(value: string): string {
  const cleaned = normalizeWhitespace(
    decodeHtmlEntities(value)
      .replace(/\b(Portfolio Team|Focus Areas|About|Team|Companies|Products|Content|Open menu|Sign in|Subscribe)\b/gi, " ")
      .replace(/\b(menu|latest news|newsletter|newsletters)\b/gi, " "),
  );

  const parts = cleaned.split(/(?<=[.!?])\s+/);
  const deduped: string[] = [];
  for (const part of parts) {
    if (!part || deduped[deduped.length - 1] === part) {
      continue;
    }
    deduped.push(part);
  }

  return normalizeWhitespace(deduped.join(" "));
}

function isFetchFailureText(value: string): boolean {
  return /\b(too many requests|rate limited|access denied|forbidden|service unavailable|temporarily unavailable)\b/i.test(value);
}

function stripMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~`>]+/g, "")
      .replace(/^\s*[-+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, ""),
  );
}

function extractJsonScript(markup: string, scriptId: string): string | null {
  const match = markup.match(new RegExp(`<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  return match?.[1] ? decodeHtmlEntities(match[1]) : null;
}

function extractA16zArticleContent(markup: string): string {
  const marker = markup.indexOf("js-article-content");
  if (marker < 0) {
    return "";
  }

  const start = markup.indexOf(">", marker);
  if (start < 0) {
    return "";
  }

  let slice = markup.slice(start + 1);
  const stopMarkers = [
    "You may also like",
    "Related Posts",
    "Up Next",
    "<footer",
  ];

  for (const stopMarker of stopMarkers) {
    const index = slice.indexOf(stopMarker);
    if (index > 0) {
      slice = slice.slice(0, index);
      break;
    }
  }

  return stripTags(slice);
}

function extractNfxArticleContent(markup: string): string {
  const nextData = extractJsonScript(markup, "__NEXT_DATA__");
  if (nextData) {
    try {
      const payload = JSON.parse(nextData) as {
        props?: {
          pageProps?: {
            post?: {
              content?: { rendered?: string };
            };
          };
        };
      };

      const rendered = payload.props?.pageProps?.post?.content?.rendered;
      if (rendered) {
        return stripTags(rendered);
      }
    } catch {
      // Fall through to HTML extraction below.
    }
  }

  const marker = markup.indexOf("post_post__");
  if (marker < 0) {
    return "";
  }

  const start = markup.indexOf(">", marker);
  if (start < 0) {
    return "";
  }

  return stripTags(markup.slice(start + 1));
}

function buildYcLaunchDocument(source: Source, entry: FeedEntry, page: PageDetails): StructuredDocument | null {
  if (page.contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(page.body) as {
        id?: number;
        title?: string;
        tagline?: string;
        body?: string;
        created_at?: string;
        url?: string;
        company?: {
          name?: string;
          batch?: string;
          industry?: string;
          url?: string;
        };
      };

      if (!payload.title || !payload.body) {
        return null;
      }

      const content = cleanContentText(stripMarkdown(
        `${payload.tagline ?? ""}\n\n${payload.body}\n\nCompany: ${payload.company?.name ?? "n/a"}\nBatch: ${payload.company?.batch ?? "n/a"}\nIndustry: ${payload.company?.industry ?? "n/a"}\nWebsite: ${payload.company?.url ?? "n/a"}`,
      ));

      return {
        id: `${source.id}:${payload.id ?? entry.url}`,
        source_id: source.id,
        source_name: source.name,
        document_type: "article",
        title: cleanDocumentTitle(payload.title),
        url: page.finalUrl,
        content,
        published_at: payload.created_at ? new Date(payload.created_at).toISOString() : (entry.published_at ?? null),
        fetched_at: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  const title = cleanDocumentTitle(
    (page.pageTitle ?? entry.title)
      .replace(/^Launch YC:\s*/i, "")
      .replace(/\s+\|\s+Y Combinator$/i, ""),
  );
  const rawExcerpt = (() => {
    const raw = page.rawText || "";
    const titleIndex = raw.lastIndexOf(title);
    if (titleIndex >= 0) {
      return raw.slice(titleIndex + title.length).slice(0, 2200);
    }
    return raw.slice(0, 2200);
  })();
  const content = cleanContentText(page.metaDescription || entry.summary || rawExcerpt);
  if (!title || !content) {
    return null;
  }

  return {
    id: `${source.id}:${entry.url}`,
    source_id: source.id,
    source_name: source.name,
    document_type: "article",
    title,
    url: page.finalUrl,
    content,
    published_at: entry.published_at ? new Date(entry.published_at).toISOString() : null,
    fetched_at: new Date().toISOString(),
  };
}

function isLennyPodcastEntry(entry: FeedEntry): boolean {
  const haystack = `${entry.title} ${entry.summary ?? ""} ${entry.content_html ?? ""}`.toLowerCase();
  return /(^|[\s])🎙️|how i ai|podcast network|listen now:|podcasts\.apple\.com|open\.spotify\.com|youtube\.com\/@howiaipodcast|episode/i.test(haystack);
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
    const title = decodeHtmlEntities(unwrapCdata(extractTagContent(block, /<title>([\s\S]*?)<\/title>/i) ?? ""));
    const url = decodeHtmlEntities(extractTagContent(block, /<link>([\s\S]*?)<\/link>/i) ?? "");
    const publishedAt = extractTagContent(block, /<pubDate>([\s\S]*?)<\/pubDate>/i);
    const author =
      decodeHtmlEntities(unwrapCdata(extractTagContent(block, /<dc:creator>([\s\S]*?)<\/dc:creator>/i) ?? ""))
      || decodeHtmlEntities(extractTagContent(block, /<author>([\s\S]*?)<\/author>/i) ?? "")
      || null;
    const summary =
      decodeHtmlEntities(stripTags(unwrapCdata(extractTagContent(block, /<description>([\s\S]*?)<\/description>/i) ?? "")))
      || decodeHtmlEntities(stripTags(extractTagContent(block, /<description>([\s\S]*?)<\/description>/i) ?? ""))
      || null;
    const contentHtml = unwrapCdata(extractTagContent(block, /<content:encoded>([\s\S]*?)<\/content:encoded>/i) ?? "") || null;

    return {
      title,
      url,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
      author: author || null,
      summary: summary || null,
      content_html: contentHtml,
    };
  }).filter((item) => item.url && item.title);
}

function detectDocumentType(page: PageDetails, entry: FeedEntry): DocumentType {
  const combined = `${entry.title} ${entry.summary ?? ""} ${page.body.slice(0, 3000)}`;
  return /twitter:player|embed\/podcast|podcast|listen now|episode/i.test(combined)
    ? "podcast"
    : "article";
}

async function fetchTechCrunchArticleContent(page: PageDetails): Promise<string> {
  const apiUrl = page.body.match(/https:\/\/techcrunch\.com\/wp-json\/wp\/v2\/posts\/\d+/)?.[0];
  if (!apiUrl) {
    return "";
  }

  try {
    const jsonText = await fetchXml(apiUrl, "application/json,text/plain;q=0.9,*/*;q=0.8");
    const payload = JSON.parse(jsonText) as {
      content?: { rendered?: string };
    };
    return payload.content?.rendered ? stripTags(payload.content.rendered) : "";
  } catch {
    return "";
  }
}

function buildContent(source: Source, documentType: DocumentType, page: PageDetails, entry: FeedEntry, preferredBody = ""): string {
  const summary = page.metaDescription || entry.summary || "";
  const pageBody = source.id === "a16z"
    ? extractA16zArticleContent(page.body) || extractPrimaryContent(page.body) || page.rawText
    : source.id === "nfx"
      ? extractNfxArticleContent(page.body) || extractPrimaryContent(page.body) || page.rawText
      : extractPrimaryContent(page.body) || page.rawText;
  const feedBody = entry.content_html ? stripTags(entry.content_html) : "";
  const bodyCandidates = [preferredBody, feedBody, pageBody]
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value && !isFetchFailureText(value))
    .sort((left, right) => right.length - left.length);
  const body = bodyCandidates[0] ?? "";

  if (documentType === "podcast") {
    return normalizeWhitespace(`${summary}\n\n${body}`).slice(0, 14000);
  }

  return normalizeWhitespace(`${summary}\n\n${body}`).slice(0, 14000);
}

function isAllowedDocumentUrl(source: Source, url: string): boolean {
  if (source.id === "yc-launches") {
    return /\/launches\/[A-Za-z0-9_-]+/.test(url);
  }

  if (source.id === "techcrunch") {
    return /^https:\/\/techcrunch\.com\/\d{4}\/\d{2}\/\d{2}\//.test(url);
  }

  if (source.id === "crunchbase") {
    return /^https:\/\/news\.crunchbase\.com\/(venture|ai|fintech-ecommerce|biggest-startup|startups)\//.test(url);
  }

  return true;
}

function isLowQualityDocument(source: Source, title: string, url: string, content: string): boolean {
  const haystack = `${title} ${url} ${content}`.toLowerCase();

  if (isFetchFailureText(haystack)) {
    return true;
  }

  if (source.id === "yc-launches") {
    return /(apply to yc|yc interview guide|people\b)/i.test(haystack);
  }

  if (source.id === "techcrunch") {
    return content.length < 500 || /techcrunch disrupt|\/events\/|\/latest\/|save close to/i.test(haystack);
  }

  if (source.id === "crunchbase") {
    return /(unicorn company list|emerging unicorn|company list|board|tracker)/i.test(haystack);
  }

  if (source.id === "a16z" || source.id === "nfx") {
    const prefix = content.slice(0, 220).toLowerCase();
    return /(portfolio team focus areas|content content team team companies companies|open menu team|we are a vc firm investing in pre-seed)/i.test(prefix);
  }

  if (source.id === "lenny-podcast") {
    return /subscribe sign in\s+how i ai/i.test(content.slice(0, 180)) || !/(podcast|how i ai|listen now|apple|spotify|youtube)/i.test(`${title} ${content}`);
  }

  if (source.id === "lenny-newsletter") {
    return /(how i ai|podcast network|listen now:|podcasts\.apple\.com|open\.spotify\.com)/i.test(`${title} ${content}`);
  }

  if (source.id === "latent-space") {
    return content.length < 500;
  }

  if (source.id === "a16z-podcast-network") {
    return /\/podcasts\/$/.test(url);
  }

  return false;
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
    if (!isAllowedDocumentUrl(source, normalized)) {
      continue;
    }
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
    if (source.id === "yc-launches") {
      return buildYcLaunchDocument(source, entry, page);
    }
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
    const title = page.pageTitle && !isFetchFailureText(page.pageTitle)
      ? page.pageTitle.split(" - by ")[0]?.split(" | ")[0] ?? entry.title
      : entry.title;
    const preferredBody = source.id === "techcrunch"
      ? await fetchTechCrunchArticleContent(page)
      : "";
    const content = buildContent(source, documentType, page, entry, preferredBody);
    const publishedAt = entry.published_at || extractPublishedAt(page.body);
    const cleanedTitle = cleanDocumentTitle(title);
    const cleanedContent = cleanContentText(content);

    if (!isAllowedDocumentUrl(source, page.finalUrl) || isLowQualityDocument(source, cleanedTitle, page.finalUrl, cleanedContent)) {
      return null;
    }

    return {
      id: `${source.id}:${entry.url}`,
      source_id: source.id,
      source_name: source.name,
      document_type: documentType,
      title: cleanedTitle,
      url: page.finalUrl,
      content: cleanedContent,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function buildSummaryOnlyDocument(source: Source, entry: FeedEntry): StructuredDocument | null {
  const title = cleanDocumentTitle(entry.title);
  const content = cleanContentText(entry.summary ?? "");

  if (!title || !content || !isAllowedDocumentUrl(source, entry.url) || isLowQualityDocument(source, title, entry.url, content)) {
    return null;
  }

  return {
    id: `${source.id}:${entry.url}`,
    source_id: source.id,
    source_name: source.name,
    document_type: source.classification === "podcast" ? "podcast" : "article",
    title,
    url: entry.url,
    content,
    published_at: entry.published_at ? new Date(entry.published_at).toISOString() : null,
    fetched_at: new Date().toISOString(),
  };
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
  const entries = parseRssItems(xml)
    .filter((entry) => source.id === "lenny-podcast"
      ? isLennyPodcastEntry(entry)
      : source.id === "lenny-newsletter"
        ? !isLennyPodcastEntry(entry)
        : true)
    .slice(0, source.entry_limit ?? 5);
  const documents = await Promise.all(entries.map(async (entry) => {
    const full = await buildDocumentFromEntry(source, entry);
    return full ?? buildSummaryOnlyDocument(source, entry);
  }));
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
  const entries = sitemapXmls
    .flatMap((xml) => parseSitemapEntries(xml))
    .filter((entry) => matchesAnyPattern(entry.url, source.url_allowlist_patterns))
    .sort((left, right) => new Date(right.lastmod ?? 0).getTime() - new Date(left.lastmod ?? 0).getTime());
  const freshEntries = entries.filter((entry) => isWithinLastDay(entry.lastmod));
  const recentEntries = (source.id === "yc-launches"
    ? entries
    : freshEntries.length > 0
      ? freshEntries
      : entries).slice(0, source.entry_limit ?? 5);

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
  const entries = sitemapXmls
    .flatMap((xml) => parseSitemapEntries(xml))
    .filter((entry) => matchesAnyPattern(entry.url, source.url_allowlist_patterns))
    .sort((left, right) => new Date(right.lastmod ?? 0).getTime() - new Date(left.lastmod ?? 0).getTime())
  const freshEntries = entries.filter((entry) => isWithinLastDay(entry.lastmod));
  const recentEntries = (freshEntries.length > 0 ? freshEntries : entries).slice(0, source.entry_limit ?? 5);

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
      const content = buildContent(source, "podcast", details, {
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
        --bg-base: #000000;
        --bg-elevated: #0d0d0f;
        --bg-surface: rgba(255, 255, 255, 0.04);
        --bg-surface-hover: rgba(255, 255, 255, 0.08);
        --ink: #ffffff;
        --ink-subtle: #b2b2b8;
        --ink-dim: #7a7a80;
        --border: rgba(255, 255, 255, 0.1);
        --border-hover: rgba(255, 255, 255, 0.2);
        --accent: #d8ff1f;
        --accent-alt: #ff4fd8;
        --accent-cyan: #45f3ff;
        --accent-line: linear-gradient(90deg, var(--accent), var(--accent-alt), var(--accent-cyan));
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg-base);
        color: var(--ink);
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
      }
      body::before {
        content: '';
        position: fixed;
        inset: 0;
        background:
          radial-gradient(circle at top left, rgba(216, 255, 31, 0.12), transparent 30%),
          radial-gradient(circle at top right, rgba(255, 79, 216, 0.09), transparent 28%),
          linear-gradient(180deg, rgba(255,255,255,0.02), transparent 14%);
        z-index: -1;
        pointer-events: none;
      }
      a { color: inherit; text-decoration: none; }
      @keyframes ticker {
        0% { transform: translateX(0); }
        100% { transform: translateX(-50%); }
      }
      .ticker-wrap {
        overflow: hidden;
        margin-bottom: 18px;
        border-top: 1px solid rgba(216, 255, 31, 0.35);
        border-bottom: 1px solid var(--border);
        background: linear-gradient(90deg, rgba(216, 255, 31, 0.08), rgba(255, 79, 216, 0.06), rgba(69, 243, 255, 0.08));
      }
      .ticker {
        display: flex;
        width: max-content;
        min-width: 200%;
        padding: 10px 0;
        color: var(--ink);
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        animation: ticker 28s linear infinite;
      }
      .ticker span {
        padding-right: 28px;
        white-space: nowrap;
      }
      .page {
        max-width: 1380px;
        margin: 0 auto;
        padding: 36px 32px 120px;
        position: relative;
        z-index: 1;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 24px;
        padding: 10px 0 18px;
        border-bottom: 1px solid var(--border);
        color: var(--ink-dim);
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.18em;
      }
      .topbar strong {
        color: var(--accent);
        font-weight: 900;
      }
      .topbar nav {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
      }
      .topbar nav a {
        position: relative;
        transition: color 160ms ease, transform 160ms ease;
      }
      .topbar nav a::after {
        content: "";
        position: absolute;
        left: 0;
        bottom: -8px;
        width: 100%;
        height: 2px;
        background: var(--accent-line);
        transform: scaleX(0);
        transform-origin: left center;
        transition: transform 180ms ease;
      }
      .topbar nav a:hover {
        color: var(--ink);
        transform: translateY(-1px);
      }
      .topbar nav a:hover::after { transform: scaleX(1); }
      .masthead {
        padding: 34px 0 0;
        text-align: left;
      }
      .masthead-top {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0;
        margin-bottom: 26px;
        border-top: 3px solid transparent;
        border-image: var(--accent-line) 1;
        border-bottom: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.02);
        color: var(--ink-dim);
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.16em;
      }
      .masthead-top span {
        padding: 14px 16px;
        border-right: 1px solid var(--border);
        transition: background 160ms ease, color 160ms ease;
      }
      .masthead-top span:hover {
        background: rgba(255, 255, 255, 0.04);
        color: var(--ink);
      }
      .masthead-top span:last-child { border-right: none; }
      .brand {
        margin: 0;
        font-size: clamp(82px, 12vw, 172px);
        line-height: 0.86;
        letter-spacing: -0.06em;
        font-weight: 900;
        text-transform: uppercase;
        color: var(--ink);
      }
      .subhead {
        max-width: 860px;
        margin: 22px 0 0;
        color: var(--ink-subtle);
        font-size: 26px;
        line-height: 1.45;
        font-weight: 500;
        letter-spacing: -0.02em;
      }
      .hero {
        display: grid;
        grid-template-columns: 1.3fr 0.7fr;
        gap: 48px;
        padding: 36px 0 56px;
        border-bottom: 1px solid var(--border);
      }
      .hero-main {
        padding-right: 16px;
      }
      .hero-side {
        border-left: 1px solid var(--border);
        padding-left: 32px;
      }
      .hero h2 {
        margin: 0;
        font-size: clamp(42px, 6vw, 74px);
        font-weight: 900;
        letter-spacing: -0.05em;
        line-height: 0.96;
        max-width: 12ch;
      }
      .hero p {
        margin: 24px 0 0;
        font-size: 21px;
        line-height: 1.55;
        color: var(--ink-subtle);
      }
      .eyebrow {
        display: inline-block;
        margin-bottom: 22px;
        padding: 8px 12px;
        border: 1px solid rgba(216, 255, 31, 0.5);
        color: var(--accent);
        background: rgba(216, 255, 31, 0.08);
        font-size: 11px;
        line-height: 1;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-weight: 900;
      }
      .actions { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 34px; }
      .button {
        padding: 16px 22px;
        font-size: 12px;
        line-height: 1;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #000;
        transition: 160ms ease;
        position: relative;
      }
      .button:hover { transform: translateY(-2px); filter: brightness(1.05); }
      .button.secondary {
        background: transparent;
        color: var(--ink);
        border-color: var(--border);
      }
      .button.secondary:hover {
        border-color: var(--accent-cyan);
        color: var(--accent-cyan);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 16px;
        margin-top: 42px;
      }
      .stat {
        padding: 24px 20px 20px;
        text-align: left;
        background: var(--bg-elevated);
        border-top: 3px solid transparent;
        border-image: var(--accent-line) 1;
        border-left: 1px solid var(--border);
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
      }
      .stat strong {
        display: block;
        font-size: clamp(42px, 5vw, 64px);
        font-weight: 900;
        letter-spacing: -0.06em;
        color: var(--ink);
        line-height: 0.88;
      }
      .stat span {
        display: block;
        margin-top: 12px;
        color: var(--ink-dim);
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.18em;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        padding-top: 56px;
      }
      .section {
        padding: 34px 28px;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        transition: border-color 180ms ease, transform 180ms ease, background 180ms ease;
      }
      .grid .section:nth-child(1) {
        background:
          linear-gradient(180deg, rgba(69, 243, 255, 0.1), transparent 38%),
          var(--bg-elevated);
      }
      .grid .section:nth-child(2) {
        background:
          linear-gradient(180deg, rgba(255, 79, 216, 0.08), transparent 34%),
          var(--bg-elevated);
      }
      .section h3, .dek h3 {
        font-size: 34px;
        font-weight: 900;
        margin: 0 0 14px;
        letter-spacing: -0.04em;
        line-height: 1;
      }
      .section p, .dek p {
        font-size: 17px;
        line-height: 1.55;
        margin: 0;
        color: var(--ink-subtle);
      }
      .dek {
        padding: 0 0 28px 0;
        border-bottom: 1px solid var(--border);
        margin-bottom: 28px;
      }
      .dek:last-child { border: none; margin: 0; padding: 0; }
      .list { list-style: none; margin: 40px 0 0; padding: 0; }
      .list li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 18px;
        padding: 18px 0;
        border-bottom: 1px solid var(--border);
        font-size: 16px;
        font-weight: 600;
        letter-spacing: -0.02em;
        transition: transform 160ms ease, border-color 160ms ease, color 160ms ease;
      }
      .list li:hover {
        transform: translateX(4px);
        border-color: rgba(255, 255, 255, 0.22);
      }
      .list li:last-child { border: none; padding-bottom: 0; }
      .list small {
        padding: 5px 10px;
        border: 1px solid var(--border);
        color: var(--accent-cyan);
        font-size: 11px;
        line-height: 1;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        white-space: nowrap;
        transition: color 160ms ease, border-color 160ms ease, background 160ms ease, transform 160ms ease;
      }
      .list li:hover small {
        color: #000;
        background: var(--accent-cyan);
        border-color: var(--accent-cyan);
        transform: translateX(2px);
      }
      .sources {
        margin-top: 64px;
        padding-top: 48px;
        border-top: 1px solid var(--border);
      }
      .sources-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
        gap: 14px;
        margin-top: 34px;
      }
      .source-card {
        padding: 24px 22px;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        transition: 160ms ease;
      }
      .source-card:hover {
        transform: translateY(-2px);
        border-color: var(--border-hover);
        background: var(--bg-surface-hover);
      }
      .source-card:nth-child(3n+1) { box-shadow: inset 0 3px 0 rgba(216, 255, 31, 0.9); }
      .source-card:nth-child(3n+2) { box-shadow: inset 0 3px 0 rgba(255, 79, 216, 0.9); }
      .source-card:nth-child(3n+3) { box-shadow: inset 0 3px 0 rgba(69, 243, 255, 0.9); }
      .source-card h3 {
        font-size: 24px;
        font-weight: 900;
        letter-spacing: -0.04em;
        margin: 0 0 12px;
        line-height: 1.02;
        transition: color 160ms ease, transform 160ms ease;
      }
      .source-eyebrow {
        display: inline-block;
        margin-bottom: 16px;
        color: var(--ink-dim);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-weight: 900;
        transition: color 160ms ease, transform 160ms ease;
      }
      .source-card p {
        font-size: 15px;
        font-weight: 500;
        color: var(--ink-subtle);
        margin: 0;
        line-height: 1.55;
        transition: color 160ms ease;
      }
      .source-meta {
        display: flex;
        gap: 16px;
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
        color: var(--ink-dim);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-weight: 900;
        transition: color 160ms ease, border-color 160ms ease;
      }
      .source-card:hover h3 {
        color: var(--accent);
        transform: translateX(3px);
      }
      .source-card:hover .source-eyebrow {
        color: var(--accent-cyan);
        transform: translateX(3px);
      }
      .source-card:hover p { color: var(--ink); }
      .source-card:hover .source-meta {
        color: var(--ink-subtle);
        border-color: rgba(255, 255, 255, 0.22);
      }
      .footer {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        margin-top: 80px;
        padding: 26px 0;
        border-top: 1px solid var(--border);
        color: var(--ink-dim);
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.18em;
      }
      .hero h2,
      .subhead,
      .section h3,
      .button,
      .source-card,
      .source-card h3,
      .source-eyebrow,
      .list li,
      .topbar nav a {
        will-change: transform;
      }
      @media (max-width: 980px) {
        .page { padding: 20px 18px 80px; }
        .topbar, .footer { flex-direction: column; align-items: flex-start; }
        .masthead-top, .hero, .stats, .grid, .sources-grid { grid-template-columns: 1fr; gap: 20px; }
        .masthead-top span { border-right: none; border-bottom: 1px solid var(--border); }
        .masthead-top span:last-child { border-bottom: none; }
        .hero-main { padding-right: 0; }
        .hero-side {
          border-left: none;
          border-top: 1px solid var(--border);
          padding-left: 0;
          padding-top: 24px;
        }
        .brand { font-size: clamp(60px, 15vw, 120px); }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="ticker-wrap">
        <div class="ticker">
          <span>Palo Wire</span>
          <span>Signal desk for agents</span>
          <span>Silicon Valley tech + VC</span>
          <span>24-hour rolling source node</span>
          <span>Official feeds, sitemaps, APIs</span>
          <span>Palo Wire</span>
          <span>Signal desk for agents</span>
          <span>Silicon Valley tech + VC</span>
          <span>24-hour rolling source node</span>
          <span>Official feeds, sitemaps, APIs</span>
        </div>
      </div>
      <div class="topbar">
        <strong>Palo Wire</strong>
        <nav>
          <a href="/api/documents">Documents</a>
          <a href="/api/sources">Sources</a>
          <a href="/api/runs/latest">Runs</a>
          <a href="https://github.com/XiaokunDuan/palo-wire">GitHub</a>
        </nav>
      </div>
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
        <h3 style="margin:0;font-size:clamp(34px, 5vw, 48px);font-weight:900;letter-spacing:-0.04em;line-height:1.03;">A mix of community, launch, media, and investor surfaces.</h3>
        <p style="margin:14px 0 0;color:var(--ink-subtle);max-width:760px;line-height:1.6;font-size:18px;">
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
