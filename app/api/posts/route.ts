import { NextRequest, NextResponse } from "next/server";
import { createPost, listPosts } from "@/lib/store";
import { normalizeBoard, readJson, resolveAuthor, str } from "@/lib/api-helpers";

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
        commentCount: 0,
      },
    },
    { status: 201 },
  );
}
