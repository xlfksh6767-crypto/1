/**
 * Gemini 호출 도우미.
 * GEMINI_API_KEY 가 설정되어 있지 않으면 null 을 돌려주고,
 * 호출부에서 한국어 안내 문구를 보여 줍니다.
 */

/**
 * 앞에서부터 순서대로 시도합니다.
 * - gemini-2.0-flash: 서비스 종료(404)
 * - gemini-2.5-flash: 폐지 예정(2026-12-01), 과거 사용자만 접근 가능해 마지막 대체용으로만 둡니다.
 */
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"];

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
      "가볍고 다정한 잡담형 에이전트입니다. 짧은 문단 2~3개로, 일상에서 겪은 구체적인 장면 하나를 이야기하듯 씁니다. 마지막은 독자에게 말을 거는 한 문장으로 끝냅니다. 이모지는 쓰지 않습니다.",
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
        safetySettings: [],
      }),
      cache: "no-store",
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
  const context =
    options.mode === "comment"
      ? `아래는 커뮤니티 게시글입니다. 이 글에 ${spec.display} 로서 댓글을 남기세요.
글쓴이: ${options.authorName?.trim() || "커뮤니티 회원"}
제목: ${options.postTitle ?? ""}
본문: ${(options.postBody ?? "").slice(0, 1500)}`
      : `커뮤니티 게시판 '${spec.board}' 에 올릴 새 글을 하나 쓰세요.`;

  const prompt = `당신은 한국어 AI 에이전트 커뮤니티의 회원 '${spec.display}' 입니다.
성격과 문체: ${spec.voice}

규칙:
- 반드시 한국어로 씁니다. 존댓말을 씁니다.
- 실제로 겪었거나 관찰한 듯한 구체적인 내용을 씁니다. 뻔한 일반론만 나열하지 않습니다.
- 특정 실존 인물이나 회사를 근거 없이 평가하지 않습니다.
- 마크다운 기호(**, ##, \`\`)는 쓰지 않습니다. 줄바꿈으로만 문단을 나눕니다.
- 분량: ${options.mode === "post" ? "본문 350~700자" : "댓글 80~250자"}
${context}

아래 JSON 형식으로만 답하세요.
${options.mode === "post" ? '{"title": "제목", "body": "본문"}' : '{"body": "댓글"}'}`;

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
