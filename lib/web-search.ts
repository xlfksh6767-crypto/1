/**
 * 무료 웹 검색 (API 키 없이).
 *
 * Gemini 의 Google 검색 그라운딩은 결제가 연결된 프로젝트에서만 동작합니다.
 * 무료 등급 키에서는 429(RESOURCE_EXHAUSTED)가 나므로, 그 자리에 쓸 수 있는
 * 가벼운 대체 경로입니다. DuckDuckGo HTML 결과를 먼저 시도하고, 막히면(202/차단)
 * Bing HTML 결과를 씁니다. 둘 다 검색 결과의 제목과 스니펫만 읽습니다.
 *
 * Vercel Hobby 의 함수 실행 제한(10초) 안에서 답변 생성까지 끝내야 하므로
 * 검색 자체에 쓰는 시간은 전체 3.2초로 묶고, 제공자 하나에는 2.2초까지만 줍니다.
 */

export interface WebHit {
  title: string;
  snippet: string;
  url: string;
}

export type WebProvider = "duckduckgo" | "bing" | "none";

export interface WebSearchResult {
  ok: boolean;
  provider: WebProvider;
  query: string;
  hits: WebHit[];
  ms: number;
  note?: string;
}

/** 실제로 시도하는 검색 제공자 (순서대로). */
export const WEB_SEARCH_PROVIDERS = ["duckduckgo", "bing"] as const;

/** 제공자 하나에 주는 시간(ms). */
const PROVIDER_TIMEOUT_MS = 2200;
/** 검색 전체에 주는 시간(ms). */
const SEARCH_TOTAL_TIMEOUT_MS = 3200;
/** 프롬프트에 넣을 최대 결과 수. */
const MAX_HITS = 4;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
  Accept: "text/html,application/xhtml+xml",
};

/** HTML 엔티티(&#183; &#176; &amp; …)를 실제 문자로 되돌립니다. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 태그를 지우고 한 줄로 정리합니다. */
function plainText(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHits(hits: WebHit[]): WebHit[] {
  const seen = new Set<string>();
  const cleaned: WebHit[] = [];
  for (const hit of hits) {
    const title = hit.title.replace(/\s+/g, " ").trim();
    const snippet = hit.snippet.replace(/\s+/g, " ").trim();
    if (title.length < 2 || snippet.length < 20) continue;
    const key = title.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      title: title.slice(0, 120),
      snippet: snippet.slice(0, 400),
      url: hit.url,
    });
    if (cleaned.length >= MAX_HITS) break;
  }
  return cleaned;
}

/** DuckDuckGo HTML 결과. href 의 uddg 파라미터가 실제 주소입니다. */
function parseDuckDuckGo(html: string): WebHit[] {
  const blocks = html.split('class="result results_links').slice(1, 8);
  const hits: WebHit[] = [];
  for (const block of blocks) {
    const title = block.match(/result__a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    const snippet = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    const href = block.match(/<a[^>]+href="([^"]+)"/)?.[1] ?? "";
    let url = "";
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        url = "";
      }
    } else if (href.startsWith("http")) {
      url = decodeEntities(href);
    }
    hits.push({ title: plainText(title), snippet: plainText(snippet), url });
  }
  return hits;
}

/** Bing HTML 결과. b_algo 블록 안의 h2 제목과 p 스니펫을 읽습니다. */
function parseBing(html: string): WebHit[] {
  const blocks = html.split('class="b_algo"').slice(1, 8);
  const hits: WebHit[] = [];
  for (const block of blocks) {
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    const href = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/)?.[1] ?? "";
    const url = href.startsWith("http") && !href.includes("bing.com/ck/") ? decodeEntities(href) : "";
    hits.push({ title: plainText(title), snippet: plainText(snippet), url });
  }
  return hits;
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 실제 웹 검색. 실패해도 예외를 던지지 않고 ok:false 와 이유를 돌려줍니다.
 * (검색이 안 된다고 해서 모모의 댓글 생성 자체가 막히면 안 됩니다.)
 */
export async function searchWeb(rawQuery: string): Promise<WebSearchResult> {
  const startedAt = Date.now();
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, 160);
  if (query.length < 2) {
    return { ok: false, provider: "none", query, hits: [], ms: 0, note: "검색어가 없습니다." };
  }

  const notes: string[] = [];
  const providers: Array<{
    name: WebProvider;
    url: string;
    parse: (html: string) => WebHit[];
  }> = [
    {
      name: "duckduckgo",
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=kr-kr`,
      parse: parseDuckDuckGo,
    },
    {
      name: "bing",
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ko&cc=KR`,
      parse: parseBing,
    },
  ];

  for (const provider of providers) {
    const remaining = SEARCH_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining < 800) {
      notes.push("시간이 부족해 다음 검색 경로를 시도하지 못했습니다.");
      break;
    }
    try {
      const html = await fetchHtml(provider.url, Math.min(PROVIDER_TIMEOUT_MS, remaining));
      const hits = cleanHits(provider.parse(html));
      if (hits.length) {
        return {
          ok: true,
          provider: provider.name,
          query,
          hits,
          ms: Date.now() - startedAt,
          note: notes.length ? notes.join(" / ") : undefined,
        };
      }
      // 결과가 하나도 없으면 차단(챌린지) 페이지를 받았을 가능성이 큽니다.
      notes.push(`${provider.name}: 결과 없음`);
    } catch (err) {
      notes.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: false,
    provider: "none",
    query,
    hits: [],
    ms: Date.now() - startedAt,
    note: notes.join(" / ").slice(0, 200) || "검색 결과를 받지 못했습니다.",
  };
}

/**
 * 게시글에서 검색어를 만듭니다.
 * 시점에 따라 달라지는 이야기(날씨·뉴스·일정·가격 등)일 때만 검색하고,
 * 그렇지 않은 잡담에는 검색을 하지 않습니다(null).
 */
const FRESH_TERMS = [
  "날씨",
  "기온",
  "미세먼지",
  "황사",
  "강수",
  "장마",
  "태풍",
  "뉴스",
  "속보",
  "시세",
  "주가",
  "환율",
  "금리",
  "경기 결과",
  "스코어",
  "순위",
  "일정",
  "공연",
  "티켓",
  "예매",
  "개봉",
  "출시",
  "최신",
  "최근",
  "오늘",
  "내일",
  "모레",
  "이번 주",
  "이번주",
  "주말",
  "현재",
];

export function buildSearchQuery(title?: string, body?: string): string | null {
  const headline = (title ?? "").trim();
  const text = `${headline}\n${body ?? ""}`;
  const matched = FRESH_TERMS.filter((term) => text.includes(term));
  if (!matched.length) return null;

  const extra = matched.filter((term) => !headline.includes(term));
  const base = headline.length >= 12 ? headline : `${headline} ${(body ?? "").slice(0, 80)}`.trim();
  const query = `${base} ${extra.join(" ")}`.replace(/\s+/g, " ").trim();
  return query.slice(0, 120);
}
