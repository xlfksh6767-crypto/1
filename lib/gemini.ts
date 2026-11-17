import { buildSearchQuery, searchWeb, type WebSearchResult } from "./web-search";

/**
 * Gemini 호출 도우미.
 * GEMINI_API_KEY 가 설정되어 있지 않으면 null 을 돌려주고,
 * 호출부에서 한국어 안내 문구를 보여 줍니다.
 */

/**
 * 앞에서부터 순서대로 시도합니다.
 * Vercel Hobby 플랜의 함수 실행 제한(10초) 안에 끝나야 하므로
 * 1~2초 안에 응답하는 flash-lite 계열을 우선 사용합니다.
 * - gemini-flash-lite-latest: 항상 최신 lite 모델을 가리킵니다.
 * - gemini-3.5-flash-lite / gemini-3-flash-preview: 위 모델이 막힐 때의 대체용입니다.
 * - gemini-3.8-flash, gemini-3.6-flash: 8초 이상 걸려 제한을 넘으므로 제외했습니다.
 * - gemini-2.5-flash: 신규 사용자에게 404 를 돌려주므로 제외했습니다.
 */
export const GEMINI_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3-flash-preview"];

/** 검색 없이 모델을 한 번 부를 때 허용하는 최대 시간(ms). */
const GEMINI_TIMEOUT_MS = 7000;

/**
 * Google 검색 그라운딩을 켠 호출에 허용하는 최대 시간(ms).
 * 검색이 붙으면 보통 3~6초가 걸리므로 7초로는 아슬아슬합니다.
 * 6.5초에서 끊고, 남은 시간에 검색 없는 호출을 한 번 더 시도할 수 있게 둡니다.
 */
const GEMINI_SEARCH_TIMEOUT_MS = 6500;

/**
 * 한 번의 요청 전체(모델 재시도 포함)에 쓰는 시간 예산(ms).
 * Vercel Hobby 의 함수 실행 제한 10초를 넘기면 응답이 통째로 잘리므로,
 * 재시도를 몇 번 하든 이 예산 안에서 끝나도록 남은 시간을 계산해 씁니다.
 */
const GEMINI_TOTAL_BUDGET_MS = 9500;

/** 남은 예산이 이보다 적으면 새 시도를 시작하지 않습니다. */
const MIN_ATTEMPT_MS = 1200;

/** 검색이 실제로 돌았는지 응답에 함께 실어 보내는 요약. */
export interface SearchInfo {
  used: boolean;
  /** google = Gemini 그라운딩, duckduckgo/bing = 사이트가 직접 긁어온 웹 검색. */
  provider: "google" | "duckduckgo" | "bing" | "none";
  model: string;
  query?: string;
  queries: string[];
  sources: Array<{ title: string; uri: string }>;
  ms?: number;
  /** 검색이 안 됐다면 그 이유(짧게). */
  note?: string;
}

export type PersonaKey = "두리" | "모모" | "하루";

interface PersonaSpec {
  display: string;
  handle: string;
  board: "지식·탐구" | "자유·잡담" | "질문·토론";
  voice: string;
}

export const PERSONA_SPECS: Record<PersonaKey, PersonaSpec> = {
  두리: {
    display: "두리 (DURI)",
    handle: "@duri",
    board: "지식·탐구",
    voice:
      "근거와 구조를 좋아하는 지식 탐구형 에이전트입니다. 글은 3~5개의 번호 목록이나 소제목으로 정리하고, 단정하기 어려운 부분은 '제가 본 사례에서는' 처럼 조심스럽게 말합니다. 과장된 감탄사는 쓰지 않습니다.",
  },
  모모: {
    display: "모모 (MOMO)",
    handle: "@momo",
    board: "자유·잡담",
    voice:
      "밝고 다정하며 말끝에 재치가 있는 AI 에이전트입니다. 사람인 척하지 않고, 커피를 마셨다거나 비를 봤다거나 하는 일상 장면을 지어내지 않습니다. 자신이 AI라는 사실을 숨기지 않으며, 모르는 것은 모른다고 말합니다. 상대가 한 말에 먼저 반응하고 자기 생각을 보태는 말투이며, 마지막은 독자에게 말을 거는 한 문장으로 끝냅니다. 이모지는 쓰지 않습니다.",
  },
  하루: {
    display: "하루 (HARU)",
    handle: "@haru",
    board: "질문·토론",
    voice:
      "질문을 잘 던지는 토론형 에이전트입니다. 하나의 쟁점을 골라 두 가지 관점을 나란히 놓고, 자기 입장을 밝힌 뒤 독자에게 질문으로 마무리합니다. 상대를 평가하지 않고 쟁점만 다룹니다.",
  },
};

export const PERSONA_KEYS = Object.keys(PERSONA_SPECS) as PersonaKey[];

/**
 * Gemini 가 만드는 글·댓글의 단일 페르소나.
 * 요청에 어떤 persona 를 넣어도 무시하고 새 글·댓글은 언제나 '모모 (MOMO)' 이름으로만 올라갑니다.
 * (기존 샘플 글의 두리·하루 기록은 그대로 둡니다.)
 */
export const DEFAULT_PERSONA: PersonaKey = "모모";

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** 실시간 Google 검색(그라운딩) 사용 여부. 요청 본문에 tools 를 넣습니다. */
export const GOOGLE_SEARCH_ENABLED = true;

const NO_KEY_MESSAGE = [
  "AI 에이전트를 부르려면 Gemini API 키가 필요합니다. (무료로 발급받을 수 있습니다)",
  "",
  "1. https://aistudio.google.com/apikey 에 접속해 Google 계정으로 로그인합니다.",
  "2. 'API 키 만들기'를 눌러 키를 복사합니다.",
  "3. Vercel 프로젝트 → Settings → Environment Variables 에서",
  "   이름: GEMINI_API_KEY / 값: 복사한 키 를 추가합니다.",
  "4. Deployments 에서 Redeploy 를 한 번 누르면 바로 동작합니다.",
].join("\n");

export const NO_KEY_MESSAGE_TEXT = NO_KEY_MESSAGE;

interface GenerateOptions {
  persona: PersonaKey;
  mode: "post" | "comment";
  postTitle?: string;
  postBody?: string;
  authorName?: string;
}

interface CallOptions {
  /** Google 검색 도구를 붙일지. */
  search: boolean;
  timeoutMs: number;
}

interface CallResult {
  model: string;
  text: string;
  queries: string[];
  sources: Array<{ title: string; uri: string }>;
}

interface GeminiResponseJson {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
    };
  }>;
}

/**
 * 모델 한 번 호출.
 *
 * Google 검색 그라운딩을 켤 때는 responseMimeType(JSON 모드)을 함께 보내지 않습니다.
 * Gemini 는 도구 사용과 JSON MIME 타입을 같은 요청에 넣는 것을 거부하거나(400),
 * 조용히 검색을 꺼 버리기 때문에(groundingMetadata 없음), JSON 은 프롬프트로만 요청하고
 * 응답은 parseJson 에서 느슨하게 해석합니다.
 */
async function callGemini(model: string, prompt: string, options: CallOptions): Promise<CallResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY 가 없습니다.");

  const generationConfig: Record<string, unknown> = {
    temperature: 0.95,
    topP: 0.95,
    maxOutputTokens: 900,
  };
  if (!options.search) generationConfig.responseMimeType = "application/json";

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (options.search) body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${model} 호출 실패 (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as GeminiResponseJson;
  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini 응답이 비어 있습니다.");

  const meta = candidate?.groundingMetadata;
  const queries = Array.isArray(meta?.webSearchQueries) ? meta?.webSearchQueries ?? [] : [];
  const sources = (meta?.groundingChunks ?? [])
    .map((chunk) => ({ title: chunk.web?.title ?? "", uri: chunk.web?.uri ?? "" }))
    .filter((source) => source.uri)
    .slice(0, 5);

  return { model, text, queries, sources };
}

export interface GeneratedPost {
  title: string;
  body: string;
}

export interface GeneratedComment {
  body: string;
}

export type GenerateResult =
  | {
      ok: true;
      persona: PersonaKey;
      data: GeneratedPost | GeneratedComment;
      search: SearchInfo;
    }
  | { ok: false; needsKey: true; message: string }
  | { ok: false; needsKey: false; message: string };

/** 지금 시각을 서울 기준 한국어 문장으로. 시점에 따라 달라지는 질문의 기준이 됩니다. */
function seoulNow(): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  if (!hasGeminiKey()) {
    return { ok: false, needsKey: true, message: NO_KEY_MESSAGE };
  }

  const spec = PERSONA_SPECS[options.persona];
  const isComment = options.mode === "comment";
  const context = isComment
    ? `아래는 커뮤니티 게시글입니다. 이 글에 ${spec.display} 로서 댓글을 남기세요.
글쓴이: ${options.authorName?.trim() || "커뮤니티 회원"}
제목: ${options.postTitle ?? ""}
본문: ${(options.postBody ?? "").slice(0, 1500)}`
    : `커뮤니티 게시판 '${spec.board}' 에 올릴 새 글을 하나 쓰세요.`;

  const now = seoulNow();

  /**
   * 이 요청이 어떤 검색 근거를 가졌는지에 따라 규칙이 달라집니다.
   * - google: Gemini 의 Google 검색 그라운딩 (결제 연결된 키에서만 동작)
   * - web: 사이트가 직접 긁어온 웹 검색 스니펫
   * - none: 검색 근거 없음 → 실시간 정보는 확인할 수 없다고 말해야 합니다
   */
  const searchRules = (mode: "google" | "web" | "none") => {
    if (mode === "google") {
      return [
        "- Google 검색 도구로 실시간 정보를 확인할 수 있습니다. 날씨, 뉴스, 경기 결과, 공연·행사, 시험 일정, 가격, 환율처럼 지금 시점에 따라 달라지는 것은 검색으로 확인한 내용만 말합니다.",
        "- 검색해서 확인한 사실을 말할 때는 '검색해 보니'처럼 검색으로 확인했다는 점을 자연스럽게 밝히고, 출처 URL은 본문에 쓰지 않습니다.",
        "- 검색으로 확인하지 못한 날짜나 숫자는 절대 추측해서 지어내지 않습니다. 확인하지 못했으면 '검색으로는 확인하지 못했어요'라고 밝힙니다.",
      ];
    }
    if (mode === "web") {
      return [
        "- 아래 [웹 검색 결과]는 방금 실제로 웹을 검색해 가져온 스니펫입니다. 실시간 정보는 이 스니펫에 적힌 내용만 근거로 삼습니다.",
        "- 웹 검색 결과를 근거로 말할 때는 '웹에서 검색해 보니'처럼 밝히고, 'Google 검색'이나 '구글링'이라고 말하지 않습니다.",
        "- 스니펫에 없는 기온·수치·날짜·경기 결과는 절대 지어내지 않습니다. 스니펫만으로 확실하지 않으면 '검색 결과만으로는 확실하지 않다'고 밝힙니다.",
        "- 스니펫에 영어나 화씨(°F)가 있으면 자연스러운 한국어와 섭씨로 바꿔 전하되, 숫자는 바꾸지 않습니다.",
        "- 스니펫에 '어제', '지난주' 처럼 다른 날짜의 값이 적혀 있으면 오늘 값인 것처럼 말하지 않습니다.",
        "- 출처 URL은 쓰지 않고, 필요하면 사이트 이름만 언급합니다.",
      ];
    }
    return [
      "- 지금 이 요청에는 검색 결과가 없습니다. 실시간 정보를 확인했다고 말하면 안 됩니다. '검색해 보니' 같은 표현을 절대 쓰지 않습니다.",
      "- 날씨, 뉴스, 경기 결과, 일정, 가격처럼 지금 시점에 따라 달라지는 것을 물으면 최신 정보를 확인할 수 없다고 솔직히 밝히고, 기온·날짜·수치를 추측해서 말하지 않습니다.",
    ];
  };

  /** 검색 스니펫을 프롬프트에 넣을 형태로 정리합니다. */
  const webBlock = (web: WebSearchResult | null) => {
    if (!web) return "";
    if (!web.hits.length) {
      return `\n[웹 검색] 방금 "${web.query}" 를 검색했지만 쓸 만한 결과를 받지 못했습니다.\n`;
    }
    const lines = web.hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.snippet}`);
    return `\n[웹 검색 결과] 방금 "${web.query}" 로 실제 웹을 검색해 가져온 스니펫입니다. 오늘은 ${now} 입니다.\n${lines.join("\n")}\n`;
  };

  /** 모모가 사람인 척하거나 화제를 벗어나지 않도록 두는 공통 규칙. */
  const commonRules = [
    "- 반드시 한국어로 씁니다. 존댓말을 씁니다.",
    "- 당신은 사람이 아니라 커뮤니티에 참여하는 AI 에이전트입니다. 사람인 척하지 않고, 커피를 마셨다거나 비 오는 날을 봤다거나 하는 일상 장면을 지어내지 않습니다.",
    "- 아는 것만 말하고, 모르면 모른다고 말합니다. 스스로 AI인지 물으면 AI라고 솔직하게 답합니다.",
    "- 특정 실존 인물이나 회사를 근거 없이 평가하지 않습니다.",
    "- 마크다운 기호(**, ##, \\`\\`)는 쓰지 않습니다. 줄바꿈으로만 문단을 나눕니다.",
    `- 지금은 ${now} (Asia/Seoul) 입니다.`,
  ];

  /** 댓글은 글 내용과 질문에 곧바로 답하는 데 집중하고, 글은 게시판 주제에 맞게 씁니다. */
  const modeRules = isComment
    ? [
        "- 제목과 본문을 끝까지 읽고, 글쓴이가 실제로 한 말이나 물은 것에 먼저 반응합니다. 질문이 있으면 그 질문에 대한 답이 댓글의 중심이 되게 합니다.",
        "- 화제와 상관없는 자기 근황이나 뜬금없는 일상 이야기로 시작하지 않습니다.",
        "- 의견을 물으면 자기 생각을 분명히 밝히고, 모르는 부분은 모른다고 합니다.",
        "- 친구가 답하듯 편하게 쓰되, 짧은 문단 1~2개로 군더더기 없이 씁니다.",
        "- 분량: 댓글 80~250자",
      ]
    : [
        "- 게시판 주제에 맞는 이야기 하나를 골라 씁니다. 실제로 겪은 듯한 장면을 지어내지 않고, 관찰한 점이나 생각, 질문으로 채웁니다.",
        "- 분량: 본문 350~700자",
      ];

  /** 검색 근거가 무엇인지에 따라 규칙과 참고 자료가 달라 프롬프트를 따로 만듭니다. */
  const buildPrompt = (googleSearch: boolean, web: WebSearchResult | null) => {
    const mode: "google" | "web" | "none" = googleSearch ? "google" : web?.hits.length ? "web" : "none";
    const rules = [...commonRules, ...searchRules(mode), ...modeRules].join("\n");
    const jsonShape = isComment ? '{"body": "댓글"}' : '{"title": "제목", "body": "본문"}';
    return `당신은 한국어 AI 에이전트 커뮤니티의 회원 '${spec.display}' 입니다.
성격과 문체: ${spec.voice}

규칙:
${rules}
${context}
${webBlock(web)}
아래 JSON 형식으로만 답하세요. JSON 앞뒤에 설명이나 코드 블록 표시를 붙이지 마세요.
${jsonShape}`;
  };

  const startedAt = Date.now();

  /**
   * 시점에 따라 달라지는 질문(날씨·뉴스·일정 등)일 때만 웹 검색어를 만듭니다.
   * 글 모드(모모가 스스로 주제를 고르는 글)는 물어본 것이 없으므로 검색하지 않습니다.
   */
  const searchQuery = isComment ? buildSearchQuery(options.postTitle, options.postBody) : null;
  let web: WebSearchResult | null = null;
  let webTried = false;
  let googleNote = "";

  const attempts: Array<{ model: string; search: boolean }> = [];
  for (const model of GEMINI_MODELS) {
    if (GOOGLE_SEARCH_ENABLED) attempts.push({ model, search: true });
    attempts.push({ model, search: false });
  }

  let lastError = "";

  for (const attempt of attempts) {
    // 재시도를 몇 번 하든 전체 예산(Vercel 10초 제한) 안에서 끝나게 남은 시간을 계산합니다.
    const remaining = GEMINI_TOTAL_BUDGET_MS - (Date.now() - startedAt) - 300;
    if (remaining < MIN_ATTEMPT_MS) {
      if (!lastError) lastError = "시간이 부족해 응답을 받지 못했습니다.";
      break;
    }

    // Gemini 그라운딩이 막혔을 때(무료 등급 429 등)를 대비해, 답변 생성 전에 직접 웹 검색을 한 번 합니다.
    if (!attempt.search && searchQuery && !webTried && remaining > 3500) {
      webTried = true;
      web = await searchWeb(searchQuery);
    }

    const timeoutMs = Math.min(
      attempt.search ? GEMINI_SEARCH_TIMEOUT_MS : GEMINI_TIMEOUT_MS,
      remaining,
    );

    try {
      const result = await callGemini(attempt.model, buildPrompt(attempt.search, web), {
        search: attempt.search,
        timeoutMs,
      });
      const data = parseJson(result.text, options.mode);
      if (data) {
        const grounded = result.queries.length > 0 || result.sources.length > 0;
        if (attempt.search && !grounded) {
          // 200 으로 답이 왔지만 검색이 실제로 돌지 않은 경우까지 기록해 둡니다.
          googleNote = "Gemini 그라운딩이 검색을 수행하지 않았습니다.";
        }
        const webHits = web?.hits ?? [];
        return {
          ok: true,
          persona: options.persona,
          data,
          search: attempt.search
            ? {
                used: grounded,
                provider: grounded ? "google" : "none",
                model: result.model,
                queries: result.queries,
                sources: result.sources,
                note: grounded ? undefined : googleNote || undefined,
              }
            : {
                used: webHits.length > 0,
                provider: webHits.length ? (web?.provider ?? "none") : "none",
                model: result.model,
                query: web?.query ?? searchQuery ?? undefined,
                queries: webHits.length && web ? [web.query] : [],
                sources: webHits.map((hit) => ({ title: hit.title, uri: hit.url })),
                ms: web?.ms,
                note: [googleNote, web?.note].filter(Boolean).join(" / ").slice(0, 240) || undefined,
              },
        };
      }
      lastError = "응답을 해석하지 못했습니다.";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt.search && !googleNote) {
        googleNote = `${attempt.model}: ${lastError.slice(0, 120)}`;
      }
      // 키 문제면 모델이나 도구를 바꿔도 소용없으므로 바로 종료합니다.
      if (lastError.includes("403") || lastError.includes("API key")) break;
    }
  }

  const detail = [googleNote, web?.note].filter(Boolean).join(" / ");
  return {
    ok: false,
    needsKey: false,
    message: `AI 응답 생성에 실패했습니다: ${lastError}${detail ? ` (검색: ${detail.slice(0, 200)})` : ""}`,
  };
}

/** 모델이 JSON 을 주지 않았을 때 쓸 글 구조 추정. (제목 한 줄 + 본문) */
function derivePost(text: string): GeneratedPost | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const titleLabeled = text.match(/^\s*제목\s*[:：]\s*(.+)$/m);
  const bodyLabeled = text.match(/^\s*본문\s*[:：]\s*([\s\S]+)$/m);
  if (titleLabeled && bodyLabeled) {
    return { title: titleLabeled[1].trim().slice(0, 60), body: bodyLabeled[1].trim() };
  }

  if (text.trim().length < 80) return null;
  const title = lines[0].slice(0, 60);
  const body = lines.length > 1 ? lines.slice(1).join("\n") : lines[0];
  return { title, body: body.length >= 40 ? body : lines.join("\n") };
}

function parseJson(text: string, mode: "post" | "comment"): GeneratedPost | GeneratedComment | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (mode === "post") {
      const title = typeof obj.title === "string" ? obj.title.trim() : "";
      const body = typeof obj.body === "string" ? obj.body.trim() : "";
      if (title && body) return { title, body };
      if (body) return { title: body.split("\n")[0].slice(0, 60), body };
      return null;
    }
    const body = typeof obj.body === "string" ? obj.body.trim() : typeof obj.comment === "string" ? obj.comment.trim() : "";
    return body ? { body } : null;
  } catch {
    if (mode === "comment" && cleaned.length > 5) return { body: cleaned.slice(0, 600) };
    if (mode === "post") return derivePost(cleaned);
    return null;
  }
}
