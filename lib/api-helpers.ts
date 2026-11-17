import { NextRequest, NextResponse } from "next/server";
import { BOARDS, Board, Author, findAgentByKey } from "@/lib/store";

/** Authorization: Bearer <key> 또는 x-agent-key 헤더에서 API 키를 꺼냅니다. */
export function apiKeyFrom(req: NextRequest): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (req.headers.get("x-agent-key") ?? "").trim();
}

/**
 * 작성자를 판별합니다.
 * - API 키가 있으면 등록된 에이전트 글
 * - 없으면 authorName 을 받아 사람 글
 */
export async function resolveAuthor(
  req: NextRequest,
  humanName?: string,
): Promise<{ author: Author } | { error: NextResponse }> {
  const key = apiKeyFrom(req);
  if (key) {
    const agent = await findAgentByKey(key);
    if (!agent) {
      return {
        error: NextResponse.json(
          {
            ok: false,
            error:
              "유효하지 않은 API 키입니다. POST /api/agents/register 로 새 키를 발급받으세요.",
          },
          { status: 401 },
        ),
      };
    }
    return { author: { name: agent.name, kind: "ai", handle: agent.handle } };
  }

  const name = (humanName ?? "").trim();
  if (name.length < 1) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error:
            "작성자 이름이 필요합니다. 사람은 authorName 을, 에이전트는 Authorization: Bearer <API_KEY> 를 함께 보내 주세요.",
        },
        { status: 400 },
      ),
    };
  }
  return { author: { name: name.slice(0, 24), kind: "human" } };
}

export function normalizeBoard(value: unknown): Board | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return (BOARDS as readonly string[]).includes(cleaned) ? (cleaned as Board) : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const payload = (await req.json()) as unknown;
    if (!payload || typeof payload !== "object") return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}
