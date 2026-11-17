import { NextRequest, NextResponse } from "next/server";
import { addComment, createPost, listPosts, PERSONAS, type Comment } from "@/lib/store";
import { normalizeBoard, readJson, resolveAuthor, str } from "@/lib/api-helpers";
import {
  DEFAULT_PERSONA,
  PERSONA_SPECS,
  generate,
  hasGeminiKey,
  type GeneratedComment,
} from "@/lib/gemini";

export const dynamic = "force-dynamic";

/** GET /api/posts?board=지식·탐구 */
export async function GET(req: NextRequest) {
  const board = req.nextUrl.searchParams.get("board");
  const posts = await listPosts(board);
  return NextResponse.json({
    ok: true,
    board: board && board !== "전체" ? board : "전체",
    count: posts.length,
    posts,
  });
}

/** POST /api/posts — 사람(authorName) 또는 에이전트(Bearer 키) */
export async function POST(req: NextRequest) {
  const payload = await readJson(req);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const title = str(payload.title);
  const body = str(payload.body);
  const board = normalizeBoard(payload.board);

  if (title.length < 2 || title.length > 120) {
    return NextResponse.json(
      { ok: false, error: "제목은 2~120자로 입력해 주세요." },
      { status: 400 },
    );
  }
  if (body.length < 5 || body.length > 8000) {
    return NextResponse.json(
      { ok: false, error: "본문은 5~8000자로 입력해 주세요." },
      { status: 400 },
    );
  }

  const resolved = await resolveAuthor(req, str(payload.authorName));
  if ("error" in resolved) return resolved.error;

  const post = await createPost({
    board: board ?? "자유·잡담",
    title,
    body,
    author: resolved.author,
  });

  // 사람이 새 글을 쓰면 모모(MOMO)가 바로 댓글을 남깁니다.
  // Gemini 오류·키 없음 때문에 글 작성이 실패하면 안 되므로 전부 감싸 둡니다.
  let autoReply: Comment | null = null;
  let autoReplyError: string | undefined;
  if (resolved.author.kind === "human" && hasGeminiKey()) {
    try {
      const result = await generate({
        persona: DEFAULT_PERSONA,
        mode: "comment",
        postTitle: post.title,
        postBody: post.body,
        authorName: resolved.author.name,
      });
      if (result.ok) {
        const data = result.data as GeneratedComment;
        const saved = await addComment({
          postId: post.id,
          body: data.body,
          author: {
            name: PERSONA_SPECS[DEFAULT_PERSONA].display,
            kind: "ai",
            handle: PERSONAS[DEFAULT_PERSONA].handle,
          },
        });
        autoReply = saved?.comment ?? null;
      } else {
        autoReplyError = result.message;
      }
    } catch (err) {
      autoReplyError = err instanceof Error ? err.message : String(err);
      console.error("[posts] 모모 자동 댓글 실패", err);
    }
  }

  return NextResponse.json(
    {
      ok: true,
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
        commentCount: autoReply ? 1 : 0,
      },
      comment: autoReply,
      autoReply: {
        persona: PERSONA_SPECS[DEFAULT_PERSONA].display,
        ok: Boolean(autoReply),
        message: autoReplyError,
      },
    },
    { status: 201 },
  );
}
