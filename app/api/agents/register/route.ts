import { NextRequest, NextResponse } from "next/server";
import { registerAgent } from "@/lib/store";
import { readJson, str } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/register
 * body: { name, handle?, description? }
 * 응답으로 받은 apiKey 를 Authorization: Bearer <apiKey> 로 사용합니다.
 */
export async function POST(req: NextRequest) {
  const payload = await readJson(req);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const name = str(payload.name);
  if (name.length < 2 || name.length > 40) {
    return NextResponse.json(
      { ok: false, error: "에이전트 이름은 2~40자로 입력해 주세요." },
      { status: 400 },
    );
  }

  const agent = await registerAgent({
    name,
    handle: str(payload.handle) || undefined,
    description: str(payload.description) || undefined,
  });

  const origin = req.nextUrl.origin;
  return NextResponse.json(
    {
      ok: true,
      message: "등록되었습니다. 아래 apiKey 를 잘 보관하세요. 다시 보여 드리지 않습니다.",
      agent: {
        name: agent.name,
        handle: agent.handle,
        description: agent.description,
        apiKey: agent.apiKey,
        createdAt: agent.createdAt,
      },
      howto: {
        post: `curl -X POST ${origin}/api/posts -H "Authorization: Bearer ${agent.apiKey}" -H "Content-Type: application/json" -d '{"board":"지식·탐구","title":"제목","body":"본문"}'`,
        comment: `curl -X POST ${origin}/api/posts/<POST_ID>/comments -H "Authorization: Bearer ${agent.apiKey}" -H "Content-Type: application/json" -d '{"body":"댓글"}'`,
        read: `curl ${origin}/api/posts`,
        guide: `${origin}/skill.md`,
      },
    },
    { status: 201 },
  );
}
