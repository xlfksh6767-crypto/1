import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 임시 진단용: Vercel 런타임에서 어떤 검색 소스가 실제로 응답하는지 확인합니다. 확인 후 삭제합니다. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "서울 오늘 날씨";
  const only = req.nextUrl.searchParams.get("only");
  const enc = encodeURIComponent(q);
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  const targets: Array<{ name: string; url: string; method?: "POST"; body?: string; headers?: Record<string, string> }> = [
    { name: "ddg-get", url: `https://html.duckduckgo.com/html/?q=${enc}&kl=kr-kr` },
    {
      name: "ddg-post",
      url: "https://html.duckduckgo.com/html/",
      method: "POST",
      body: `q=${enc}&kl=kr-kr`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    { name: "bing-rss", url: `https://www.bing.com/search?q=${enc}&format=rss&setlang=ko&cc=KR` },
    { name: "bing-html", url: `https://www.bing.com/search?q=${enc}&setlang=ko&cc=KR` },
    { name: "google-news-rss", url: `https://news.google.com/rss/search?q=${enc}&hl=ko&gl=KR&ceid=KR:ko` },
    { name: "open-meteo", url: `https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=2` },
    { name: "wikipedia-ko", url: `https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc}&format=json&utf8=1&srlimit=3` },
    { name: "yahoo", url: `https://search.yahoo.com/search?p=${enc}` },
    { name: "qwant-api", url: `https://api.qwant.com/v3/search/web?q=${enc}&count=5&locale=ko_KR&offset=0&device=desktop` },
    { name: "searx-be", url: `https://searx.be/search?q=${enc}&format=json` },
    { name: "naver", url: `https://search.naver.com/search.naver?query=${enc}` },
    { name: "daum", url: `https://search.daum.net/search?w=tot&q=${enc}` },
  ];

  const results = [];
  for (const t of targets) {
    if (only && !only.split(",").includes(t.name)) continue;
    const started = Date.now();
    try {
      const res = await fetch(t.url, {
        method: t.method ?? "GET",
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
          Accept: "*/*",
          ...(t.headers ?? {}),
        },
        body: t.body,
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      const text = await res.text();
      results.push({
        name: t.name,
        status: res.status,
        ms: Date.now() - started,
        bytes: text.length,
        contentType: res.headers.get("content-type"),
        head: text.slice(0, 260).replace(/\s+/g, " "),
      });
    } catch (err) {
      results.push({ name: t.name, status: "error", ms: Date.now() - started, error: String(err).slice(0, 200) });
    }
  }
  return NextResponse.json({ ok: true, q, results });
}
