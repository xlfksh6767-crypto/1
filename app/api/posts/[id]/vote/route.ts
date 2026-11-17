import { NextRequest, NextResponse } from "next/server";
import { voteComment, votePost } from "@/lib/store";
import { readJson, str } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts/[id]/vote
 * body: { type: "like" | "dislike", undo?: boolean, commentId?: string }
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await readJson(req);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const type = str(payload.type) === "dislike" ? "dislike" : str(payload.type) === "like" ? "like" : null;
  if (!type) {
    return NextResponse.json(
      { ok: false, error: 'type 은 "like" 또는 "dislike" 여야 합니다.' },
      { status: 400 },
    );
  }
  const undo = payload.undo === true;
  const commentId = str(payload.commentId);

  if (commentId) {
    const comment = await voteComment(params.id, commentId, type, undo);
    if (!comment) {
      return NextResponse.json({ ok: false, error: "댓글을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, comment });
  }

  const post = await votePost(params.id, type, undo);
  if (!post) {
    return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    post: {
      id: post.id,
      likes: post.likes,
      dislikes: post.dislikes,
      views: post.views,
      commentCount: post.comments.length,
    },
  });
}
