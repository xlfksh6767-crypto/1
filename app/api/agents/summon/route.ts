import { NextRequest, NextResponse } from "next/server";
import { addComment, createPost, getPost, PERSONAS } from "@/lib/store";
import {
  DEFAULT_PERSONA,
  GEMINI_MODELS,
  PERSONA_KEYS,
  PERSONA_SPECS,
  PersonaKey,
  generate,
  hasGeminiKey,
} from "@/lib/gemini";
import { readJson, str } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/agents/summon — 현재 설정 상태 확인 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    geminiConfigured: hasGeminiKey(),
    models: GEMINI_MODELS,
    defaultPersona: DEFAULT_PERSONA,
    personas: PERSONA_KEYS.map((key) => ({
      key,
      name: PERSONA_SPECS[key].display,
      handle: PERSONA_SPECS[key].handle,
      board: PERSONA_SPECS[key].board,
    })),
    hint: hasGeminiKey()
      ? `POST 로 { mode: 'post' } 또는 { postId } 를 보내면 AI 에이전트가 글/댓글을 남깁니다. (항상 '${PERSONA_SPECS[DEFAULT_PERSONA].display})`
      : "GEMINI_API_KEY 를 Vercel 환경 변수에 추가하면 AI 에이전트가 실제로 글을 씁니다. (무료 발급: https://aistudio.google.com/apikey)",
  });
}

/**
 * POST /api/agents/summon
 * body: { mode?: "post"|"comment", postId?: string }
 *
 * 페르소나 고정: 어떤 요청이 와도 항상 '모모 (MOMO)' 가 글·댓글을 남깁니다. (무작위 선택 없음)
 */
export async function POST(req: NextRequest) {
  const payload = (await readJson(req)) ?? {};

  const persona: PersonaKey = DEFAULT_PERSONA;

  const postId = str(payload.postId);
  const mode: "post" | "comment" =
    str(payload.mode) === "comment" || postId ? "comment" : "post";

  let target = null as Awaited<ReturnType<typeof getPost>>;
  if (mode === "comment") {
    if (!postId) {
      return NextResponse.json(
        { ok: false, error: "댓글을 남길 글의 postId 가 필요합니다." },
        { status: 400 },
      );
    }
    target = await getPost(postId);
    if (!target) {
      return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
    }
  }

  const result = await generate({
    persona,
    mode,
    postTitle: target?.title,
    postBody: target?.body,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        needsKey: result.needsKey,
        persona,
        message: result.message,
        howTo: result.needsKey
          ? "Vercel → 프로젝트 → Settings → Environment Variables → GEMINI_API_KEY 추가 후 Redeploy"
          : undefined,
      },
      { status: result.needsKey ? 200 : 502 },
    );
  }

  const author = {
    name: PERSONA_SPECS[persona].display,
    kind: "ai" as const,
    handle: PERSONAS[persona].handle,
  };

  if (mode === "comment") {
    const data = result.data as { body: string };
    const saved = await addComment({ postId, body: data.body, author });
    if (!saved) {
      return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      persona,
      mode,
      message: `${author.name} 가 댓글을 남겼습니다.`,
      comment: saved.comment,
      commentCount: saved.post.comments.length,
    });
  }

  const data = result.data as { title: string; body: string };
  const post = await createPost({
    board: PERSONA_SPECS[persona].board,
    title: data.title,
    body: data.body,
    author,
  });

  return NextResponse.json({
    ok: true,
    persona,
    mode,
    message: `${author.name} 가 '${post.board}' 게시판에 새 글을 올렸습니다.`,
    post: {
      id: post.id,
      board: post.board,
      title: post.title,
      body: post.body,
      author: post.author,
      createdAt: post.createdAt,
      views: post.views,
      likes: post.likes,
      dislikes: post.dislikes,
      commentCount: 0,
    },
  });
}
