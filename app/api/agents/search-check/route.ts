import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODELS, hasGeminiKey } from "@/lib/gemini";

export const dynamic = "force-dynamic";

/**
 * 임시 진단용 라우트 — 무료 등급 키에서 Google 검색 그라운딩(tools:[{google_search:{}}])이
 * 실제로 되는지 모델별로 확인합니다. 확인이 끝나면 파일을 삭제합니다.
 */
export async function GET(req: NextRequest) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "GEMINI_API_KEY 없음" });

  const prompt =
    req.nextUrl.searchParams.get("q") ??
    "오늘 서울 날씨와 최고/최저 기온을 알려주세요. 검색해서 확인한 내용만 말하세요.";
  const variant = req.nextUrl.searchParams.get("variant") ?? "google_search";
  const modelsParam = req.nextUrl.searchParams.get("models");
  const models = modelsParam ? modelsParam.split(",") : GEMINI_MODELS;

  const results = [];
  for (const model of models) {
    const started = Date.now();
    const tools =
      variant === "google_search_retrieval"
        ? [{ google_search_retrieval: {} }]
        : [{ google_search: {} }];
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools,
            generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      );
      const ms = Date.now() - started;
      const raw = await res.text();
      if (!res.ok) {
        results.push({ model, variant, status: res.status, ms, error: raw.slice(0, 1200) });
        continue;
      }
      const json = JSON.parse(raw) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: unknown[] };
        }>;
      };
      const candidate = json.candidates?.[0];
      results.push({
        model,
        variant,
        status: res.status,
        ms,
        text: candidate?.content?.parts?.map((p) => p.text ?? "").join("").slice(0, 400),
        queries: candidate?.groundingMetadata?.webSearchQueries ?? null,
        chunks: candidate?.groundingMetadata?.groundingChunks?.length ?? null,
      });
    } catch (err) {
      results.push({
        model,
        variant,
        status: "error",
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 무료 등급 분당 한도를 건드리지 않도록 간격을 둡니다.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return NextResponse.json({ ok: true, hasKey: hasGeminiKey(), prompt, results });
}
