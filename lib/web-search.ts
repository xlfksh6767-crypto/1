/**
 * 무료 웹 검색 (API 키 없이).
 *
 * Gemini 의 Google 검색 그라운딩은 결제가 연결된 프로젝트에서만 동작합니다.
 * 무료 등급 키에서는 429(RESOURCE_EXHAUSTED)가 나므로, 그 자리에 쓸 수 있는 대체 경로입니다.
 *
 * 2026-11-18 Vercel 런타임에서 실측한 결과:
 * - html.duckduckgo.com : 403 (데이터센터 IP 차단) → 그래도 혹시 열려 있을 때를 위해 첫 순서로 시도
 * - www.bing.com (HTML/RSS) : 응답은 오지만 한국어 결과 품질이 낮아 사용하지 않음
 * - news.google.com/rss : 200, 한국어 뉴스 결과 정상 (약 20~350ms)
 * - api.open-meteo.com : 200, 날씨 실측값 (무료·키 불필요)
 *
 * 그래서 일반 검색은 DuckDuckGo → Google 뉴스 RSS, 날씨 질문은 Open-Meteo 를 함께 씁니다.
 * Vercel Hobby 의 10초 제한 안에서 답변 생성까지 끝내야 하므로 검색은 병렬로 돌리고
 * 전체에 2.5초만 줍니다.
 */

export interface WebHit {
  title: string;
  snippet: string;
  url: string;
}

export type WebProvider = "duckduckgo" | "google-news" | "open-meteo" | "mixed" | "none";

export interface WebSearchResult {
  ok: boolean;
  provider: WebProvider;
  query: string;
  hits: WebHit[];
  ms: number;
  note?: string;
}

/** 실제로 시도하는 검색 소스. */
export const WEB_SEARCH_PROVIDERS = ["duckduckgo", "google-news", "open-meteo"] as const;

/** 소스 하나에 주는 시간(ms). */
const SOURCE_TIMEOUT_MS = 2000;
/** 검색 전체에 주는 시간(ms). 병렬 실행이라 실제로는 가장 느린 소스 시간입니다. */
const SEARCH_TOTAL_TIMEOUT_MS = 2500;
/** 프롬프트에 넣을 최대 결과 수. */
const MAX_HITS = 4;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** HTML/XML 엔티티(&#183; &#176; &amp; …)를 실제 문자로 되돌립니다. */
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
    if (title.length < 2) continue;
    const key = title.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ title: title.slice(0, 120), snippet: snippet.slice(0, 400), url: hit.url });
  }
  return cleaned;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
      Accept: "*/*",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* --------------------------------------------------------- DuckDuckGo */

function parseDuckDuckGo(html: string): WebHit[] {
  const blocks = html.split('class="result results_links').slice(1, 8);
  const hits: WebHit[] = [];
  for (const block of blocks) {
    const title = plainText(block.match(/result__a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
    const snippet = plainText(block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
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
    hits.push({ title, snippet, url });
  }
  return hits.filter((hit) => hit.title && hit.snippet.length >= 20);
}

/* ------------------------------------------------------- Google 뉴스 RSS */

function parseNewsRss(xml: string, maxAgeDays?: number): WebHit[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const parsed: Array<{ hit: WebHit; date: number }> = [];
  for (const item of items.slice(0, 10)) {
    const rawTitle = decodeEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
    const description = plainText(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const published = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const date = published ? new Date(published).getTime() : NaN;

    // 제목은 보통 "기사 제목 - 언론사" 형태입니다.
    const splitAt = rawTitle.lastIndexOf(" - ");
    const headline = splitAt > 0 ? rawTitle.slice(0, splitAt) : rawTitle;
    const publisher = splitAt > 0 ? rawTitle.slice(splitAt + 3) : "";
    const when = formatPubDate(published);
    const snippet = description
      .replace(/\s*https?:\/\/\S+/g, "")
      .replace(/\s*-\s*[^-]{2,20}$/, "")
      .trim();
    parsed.push({
      date: Number.isFinite(date) ? date : 0,
      hit: {
        title: `${headline}${publisher ? ` - ${publisher}` : ""}`.trim(),
        snippet: `${when ? `${when} · ` : ""}${snippet || headline}`,
        url: link,
      },
    });
  }

  // 최신 기사부터. 오래된 기사는 "오늘" 질문에 섞이지 않도록 걸러 냅니다.
  parsed.sort((a, b) => b.date - a.date);
  const now = Date.now();
  const fresh = maxAgeDays
    ? parsed.filter((item) => !item.date || now - item.date <= maxAgeDays * 24 * 60 * 60 * 1000)
    : parsed;
  return (fresh.length ? fresh : parsed).map((item) => item.hit);
}

/** RSS 의 pubDate(RFC822)를 한국어 짧은 날짜로. */
function formatPubDate(pubDate: string): string {
  if (!pubDate) return "";
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------ Open-Meteo */

const WEATHER_CODES: Record<number, string> = {
  0: "맑음",
  1: "대체로 맑음",
  2: "구름 조금",
  3: "흐림",
  45: "안개",
  48: "서리 안개",
  51: "약한 이슬비",
  53: "이슬비",
  55: "강한 이슬비",
  56: "어는 이슬비",
  57: "강한 어는 이슬비",
  61: "약한 비",
  63: "비",
  65: "강한 비",
  66: "어는 비",
  67: "강한 어는 비",
  71: "약한 눈",
  73: "눈",
  75: "강한 눈",
  77: "싸락눈",
  80: "약한 소나기",
  81: "소나기",
  82: "강한 소나기",
  85: "약한 소낙눈",
  86: "강한 소낙눈",
  95: "뇌우",
  96: "우박 동반 뇌우",
  99: "강한 우박 동반 뇌우",
};

/** 검색어에서 날씨 관련 낱말을 걷어내고 지역 이름만 남깁니다. */
function extractPlace(query: string): string {
  const noise = [
    "날씨",
    "기온",
    "온도",
    "최고",
    "최저",
    "오늘",
    "내일",
    "모레",
    "이번 주",
    "이번주",
    "주말",
    "현재",
    "지금",
    "어때요",
    "어때",
    "어떤가요",
    "어떤지",
    "어떻게",
    "알려주세요",
    "알려줘",
    "궁금합니다",
    "궁금해요",
    "미세먼지",
    "초미세먼지",
    "황사",
    "강수",
    "예보",
    "우산",
    "챙겨야",
    "할까요",
    "기상청",
    "소식",
  ];
  let place = query;
  for (const word of noise) place = place.split(word).join(" ");
  place = place.replace(/[?？!.,~"'()]/g, " ").replace(/\s+/g, " ").trim();
  for (const word of noise) place = place.split(word).join(" ").trim();
  return place.replace(/\s+/g, " ").trim().slice(0, 30);
}

interface MeteoCurrent {
  temperature_2m?: number;
  apparent_temperature?: number;
  relative_humidity_2m?: number;
  weather_code?: number;
}
interface MeteoDaily {
  time?: string[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
  weather_code?: number[];
}
interface MeteoResponse {
  current?: MeteoCurrent;
  daily?: MeteoDaily;
}

type GeoSpot = { name?: string; latitude?: number; longitude?: number; admin1?: string; country?: string; country_code?: string; population?: number };

/**
 * Open-Meteo 지오코딩은 "서울" 같은 짧은 한국어 지명에 결과를 못 주거나
 * 엉뚱한 동네(충북의 산 이름 등)를 먼저 돌려줍니다. 그래서 주요 도시는 좌표를 직접 둡니다.
 */
const CITY_COORDS: Record<string, { lat: number; lon: number; label: string }> = {
  서울: { lat: 37.5665, lon: 126.978, label: "서울" },
  부산: { lat: 35.1796, lon: 129.0756, label: "부산" },
  대구: { lat: 35.8714, lon: 128.6014, label: "대구" },
  인천: { lat: 37.4563, lon: 126.7052, label: "인천" },
  광주: { lat: 35.1595, lon: 126.8526, label: "광주" },
  대전: { lat: 36.3504, lon: 127.3845, label: "대전" },
  울산: { lat: 35.5384, lon: 129.3114, label: "울산" },
  세종: { lat: 36.48, lon: 127.289, label: "세종" },
  수원: { lat: 37.2636, lon: 127.0286, label: "수원" },
  성남: { lat: 37.42, lon: 127.1265, label: "성남" },
  고양: { lat: 37.6584, lon: 126.832, label: "고양" },
  용인: { lat: 37.2411, lon: 127.1776, label: "용인" },
  부천: { lat: 37.5034, lon: 126.766, label: "부천" },
  안산: { lat: 37.3219, lon: 126.8309, label: "안산" },
  안양: { lat: 37.3943, lon: 126.9568, label: "안양" },
  남양주: { lat: 37.636, lon: 127.2165, label: "남양주" },
  화성: { lat: 37.1995, lon: 126.8312, label: "화성" },
  평택: { lat: 36.9921, lon: 127.1129, label: "평택" },
  의정부: { lat: 37.7381, lon: 127.0337, label: "의정부" },
  파주: { lat: 37.7599, lon: 126.7802, label: "파주" },
  김포: { lat: 37.6153, lon: 126.7156, label: "김포" },
  하남: { lat: 37.5393, lon: 127.2148, label: "하남" },
  이천: { lat: 37.272, lon: 127.435, label: "이천" },
  춘천: { lat: 37.8813, lon: 127.73, label: "춘천" },
  원주: { lat: 37.3422, lon: 127.9202, label: "원주" },
  강릉: { lat: 37.7519, lon: 128.8761, label: "강릉" },
  속초: { lat: 38.207, lon: 128.5918, label: "속초" },
  동해: { lat: 37.5247, lon: 129.1143, label: "동해" },
  삼척: { lat: 37.4499, lon: 129.1652, label: "삼척" },
  청주: { lat: 36.6424, lon: 127.489, label: "청주" },
  충주: { lat: 36.991, lon: 127.9259, label: "충주" },
  제천: { lat: 37.1326, lon: 128.191, label: "제천" },
  천안: { lat: 36.8151, lon: 127.1139, label: "천안" },
  아산: { lat: 36.7898, lon: 127.0018, label: "아산" },
  서산: { lat: 36.7848, lon: 126.4503, label: "서산" },
  전주: { lat: 35.8242, lon: 127.148, label: "전주" },
  익산: { lat: 35.9483, lon: 126.9576, label: "익산" },
  군산: { lat: 35.9676, lon: 126.7369, label: "군산" },
  목포: { lat: 34.8118, lon: 126.3922, label: "목포" },
  여수: { lat: 34.7604, lon: 127.6622, label: "여수" },
  순천: { lat: 34.9506, lon: 127.4872, label: "순천" },
  포항: { lat: 36.019, lon: 129.3435, label: "포항" },
  경주: { lat: 35.8562, lon: 129.2247, label: "경주" },
  구미: { lat: 36.1195, lon: 128.3446, label: "구미" },
  안동: { lat: 36.5684, lon: 128.7294, label: "안동" },
  경산: { lat: 35.8251, lon: 128.7415, label: "경산" },
  창원: { lat: 35.228, lon: 128.6811, label: "창원" },
  진주: { lat: 35.18, lon: 128.1076, label: "진주" },
  김해: { lat: 35.2342, lon: 128.8894, label: "김해" },
  양산: { lat: 35.335, lon: 129.037, label: "양산" },
  거제: { lat: 34.8806, lon: 128.6211, label: "거제" },
  통영: { lat: 34.8544, lon: 128.4331, label: "통영" },
  제주: { lat: 33.4996, lon: 126.5312, label: "제주" },
  서귀포: { lat: 33.2541, lon: 126.56, label: "서귀포" },
  평창: { lat: 37.3705, lon: 128.39, label: "평창" },
  홍천: { lat: 37.697, lon: 127.8886, label: "홍천" },
  양양: { lat: 38.0754, lon: 128.6187, label: "양양" },
  남원: { lat: 35.4164, lon: 127.3905, label: "남원" },
  정읍: { lat: 35.5699, lon: 126.8559, label: "정읍" },
};

const PLACE_SUFFIX = /(특별시|광역시|특별자치시|특별자치도|시|군|구|도|읍|면|동)$/;

function lookupCity(token: string): { lat: number; lon: number; label: string } | null {
  const raw = token.trim();
  if (!raw) return null;
  const stripped = raw.replace(PLACE_SUFFIX, "").trim();
  return CITY_COORDS[raw] ?? CITY_COORDS[stripped] ?? null;
}

async function geocode(place: string, timeoutMs: number): Promise<GeoSpot | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=10&language=ko&format=json`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: GeoSpot[] };
  const spots = (json.results ?? []).filter(
    (spot) => typeof spot.latitude === "number" && typeof spot.longitude === "number" && spot.country_code === "KR",
  );
  if (!spots.length) return null;
  // 인구가 가장 많은 곳(실제 도시)을 고릅니다.
  return spots.sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
}

async function fetchWeather(query: string, timeoutMs: number): Promise<WebHit[]> {
  // "이번 주말 서울 날씨" 처럼 조사·수식어가 섞여 있어도 지역을 찾도록,
  // (1) 주요 도시 표 → (2) 정리한 문장·낱말 순서로 지오코딩 → (3) 서울 순으로 찾습니다.
  const cleaned = extractPlace(query);
  const tokens = cleaned.split(" ").map((token) => token.trim()).filter((token) => token.length >= 2);

  let point: { lat: number; lon: number; label: string } | null = null;
  for (const candidate of [cleaned, ...tokens]) {
    const city = lookupCity(candidate);
    if (city) {
      point = city;
      break;
    }
  }
  if (!point) {
    for (const candidate of [cleaned, ...tokens].slice(0, 3)) {
      const spot = await geocode(candidate, timeoutMs);
      if (spot && typeof spot.latitude === "number" && typeof spot.longitude === "number") {
        point = { lat: spot.latitude, lon: spot.longitude, label: spot.name ?? candidate };
        break;
      }
    }
  }
  if (!point) point = { ...CITY_COORDS.서울 };

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lon}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FSeoul&forecast_days=1";
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`날씨 HTTP ${res.status}`);
  const data = (await res.json()) as MeteoResponse;

  const day = data.daily?.time?.[0] ?? "";
  const high = data.daily?.temperature_2m_max?.[0];
  const low = data.daily?.temperature_2m_min?.[0];
  const rain = data.daily?.precipitation_probability_max?.[0];
  const dayCode = data.daily?.weather_code?.[0];
  const cur = data.current;

  const parts: string[] = [];
  if (typeof cur?.temperature_2m === "number") {
    const condition = typeof cur.weather_code === "number" ? WEATHER_CODES[cur.weather_code] ?? "" : "";
    parts.push(
      `현재 ${cur.temperature_2m.toFixed(1)}°C${condition ? ` (${condition})` : ""}` +
        (typeof cur.apparent_temperature === "number" ? `, 체감 ${cur.apparent_temperature.toFixed(1)}°C` : "") +
        (typeof cur.relative_humidity_2m === "number" ? `, 습도 ${Math.round(cur.relative_humidity_2m)}%` : ""),
    );
  }
  if (typeof high === "number" && typeof low === "number") {
    parts.push(`오늘 최저 ${low.toFixed(1)}°C · 최고 ${high.toFixed(1)}°C`);
  }
  if (typeof rain === "number") parts.push(`강수확률 최대 ${Math.round(rain)}%`);
  if (typeof dayCode === "number") parts.push(`오늘 하늘 ${WEATHER_CODES[dayCode] ?? dayCode}`);
  if (!parts.length) return [];

  return [
    {
      title: `${point.label} 날씨 (Open-Meteo 실측·예보)`,
      snippet: `${day ? `${day} 기준 · ` : ""}${parts.join(", ")}.`,
      url: "https://open-meteo.com/",
    },
  ];
}

/* --------------------------------------------------------------- 공개 API */

type SourceOutcome = { provider: WebProvider; hits: WebHit[]; note?: string };

async function tryDuckDuckGo(query: string, timeoutMs: number): Promise<SourceOutcome> {
  try {
    const html = await fetchText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=kr-kr`,
      timeoutMs,
    );
    const hits = parseDuckDuckGo(html);
    return { provider: "duckduckgo", hits, note: hits.length ? undefined : "duckduckgo: 결과 없음" };
  } catch (err) {
    return { provider: "duckduckgo", hits: [], note: `duckduckgo: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function fetchNewsRss(query: string, timeoutMs: number): Promise<string> {
  return fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`,
    timeoutMs,
  );
}

async function tryNewsRss(query: string, timeoutMs: number): Promise<SourceOutcome> {
  const notes: string[] = [];
  // 최근 일주일 기사만 먼저 찾고, 없거나 실패하면 기간 제한 없이 다시 찾습니다.
  for (const searchQuery of [`${query} when:7d`, query]) {
    try {
      const xml = await fetchNewsRss(searchQuery, timeoutMs);
      const hits = cleanHits(parseNewsRss(xml, searchQuery.endsWith("when:7d") ? 8 : undefined));
      if (hits.length) return { provider: "google-news", hits, note: notes.length ? notes.join(" / ") : undefined };
      notes.push("google-news: 결과 없음");
    } catch (err) {
      notes.push(`google-news: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { provider: "google-news", hits: [], note: notes.join(" / ").slice(0, 160) };
}

async function tryWeather(query: string, timeoutMs: number): Promise<SourceOutcome> {
  try {
    const hits = await fetchWeather(query, timeoutMs);
    return { provider: "open-meteo", hits, note: hits.length ? undefined : "open-meteo: 값 없음" };
  } catch (err) {
    return { provider: "open-meteo", hits: [], note: `open-meteo: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const WEATHER_TERMS = ["날씨", "기온", "미세먼지", "황사", "강수", "장마", "태풍", "예보", "우산"];

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

  const wantsWeather = WEATHER_TERMS.some((term) => query.includes(term));

  // 소스를 병렬로 부릅니다. 가장 느린 소스가 전체 시간을 정합니다.
  const skipped: SourceOutcome = { provider: "none", hits: [] };
  const [ddg, news, weather] = await Promise.all([
    tryDuckDuckGo(query, SOURCE_TIMEOUT_MS),
    tryNewsRss(query, SOURCE_TIMEOUT_MS),
    wantsWeather ? tryWeather(query, SOURCE_TIMEOUT_MS) : Promise.resolve(skipped),
  ]);

  const notes = [ddg.note, news.note, weather.note].filter(Boolean) as string[];

  // 날씨 질문이면 실측값을 가장 앞에 둡니다. (뉴스 기사보다 정확합니다)
  const primary = weather.hits.length ? weather : ddg.hits.length ? ddg : news.hits.length ? news : null;
  if (!primary) {
    return {
      ok: false,
      provider: "none",
      query,
      hits: [],
      ms: Date.now() - startedAt,
      note: notes.join(" / ").slice(0, 240) || "검색 결과를 받지 못했습니다.",
    };
  }

  const combined: WebHit[] = [];
  const used = new Set<WebProvider>();
  for (const source of [primary, ddg, news, weather]) {
    if (!source.hits.length) continue;
    used.add(source.provider as WebProvider);
    combined.push(...source.hits);
    if (combined.length >= MAX_HITS) break;
  }
  const hits = cleanHits(combined).slice(0, MAX_HITS);
  const provider: WebProvider = used.size > 1 ? "mixed" : (primary.provider as WebProvider);

  return {
    ok: hits.length > 0,
    provider,
    query,
    hits,
    ms: Date.now() - startedAt,
    note: notes.length ? notes.join(" / ").slice(0, 240) : undefined,
  };
}

/**
 * 게시글에서 검색어를 만듭니다.
 * 시점에 따라 달라지는 이야기(날씨·뉴스·일정·가격 등)일 때만 검색하고,
 * 그렇지 않은 잡담에는 검색을 하지 않습니다(null).
 */
const FRESH_TERMS = [
  ...WEATHER_TERMS,
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
