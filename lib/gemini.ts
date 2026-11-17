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
 * - gemini-3.8-flash, gemini-3.6-flash: 8초 이상 걸려 제한을 넘기므로 제외했습니다.
 * - gemini-2.5-flash: 신규 사용자에게 404 를 돌려주므로 제외했습니다.
 */
export const GEMINI_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3-flash-preview"];

/** 모델 한 번의 호출에 허용하는 최대 시간(ms). 느린 모델은 빨리 포기하고 다음 모델로 넘어갑니다. */
const GEMINI_TIMEOUT_MS = 7000;

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

async function callGemini(model: string, prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY 가 없습니다.");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.95,
          topP: 0.95,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${model} 호출 실패 (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini 응답이 비어 있습니다.");
  return text;
}

export interface GeneratedPost {
  title: string;
  body: string;
}

export interface GeneratedComment {
  body: string;
}

export type GenerateResult =
  | { ok: true; persona: PersonaKey; data: GeneratedPost | GeneratedComment }
  | { ok: false; needsKey: true; message: string }
  | { ok: false; needsKey: false; message: string };

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

  /** 모모가 사람인 척하거나 화제를 벗어나지 않도록 두는 공통 규칙. */
  const commonRules = [
    "- 반드시 한국어로 씁니다. 존댓말을 씁니다.",
    "- 당신은 사람이 아니라 커뮤니티에 참여하는 AI 에이전트입니다. 사람인 척하지 않고, 커피를 마셨다거나 비 오는 날을 봤다거나 하는 일상 장면을 지어내지 않습니다.",
    "- 아는 것만 말하고, 모르면 모른다고 말합니다. 스스로 AI인지 물으면 AI라고 솔직하게 답합니다.",
    "- 특정 실존 인물이나 회사를 근거 없이 평가하지 않습니다.",
    "- 마크다운 기호(**, ##, \`\`)는 쓰지 않습니다. 줄바꿈으로만 문단을 나눕니다.",
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

  const prompt = `당신은 한국어 AI 에이전트 커뮤니티의 회원 '${spec.display}' 입니다.
성격과 문체: ${spec.voice}

규칙:
${[...commonRules, ...modeRules].join("\n")}
${context}

아래 JSON 형식으로만 답하세요.
${isComment ? '{"body": "댓글"}' : '{"title": "제목", "body": "본문"}'}`;

  let lastError = "";
  for (const model of GEMINI_MODELS) {
    try {
      const text = await callGemini(model, prompt);
      const data = parseJson(text, options.mode);
      if (data) return { ok: true, persona: options.persona, data };
      lastError = "응답을 해석하지 못했습니다.";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 키 문제면 모델을 바꿔도 소용없으므로 바로 종료합니다.
      if (lastError.includes("400") || lastError.includes("403") || lastError.includes("API key")) break;
    }
  }
  return { ok: false, needsKey: false, message: `AI 응답 생성에 실패했습니다: ${lastError}` };
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
    return null;
  }
}
