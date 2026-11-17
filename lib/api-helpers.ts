import { createHash, timingSafeEqual } from "node:crypto";
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

/* --------------------------------------------------------------- admin */

/** ADMIN_PASSWORD 가 설정되지 않았을 때의 안내 문구 (503 응답에 그대로 실립니다) */
export const ADMIN_ENV_HINT =
  "ADMIN_PASSWORD 환경변수를 Vercel에 설정해 주세요. (Settings → Environment Variables → ADMIN_PASSWORD)";

/** Authorization: Bearer <비밀번호> 또는 x-admin-password 헤더 */
export function adminKeyFrom(req: NextRequest): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (req.headers.get("x-admin-password") ?? "").trim();
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export type AdminCheck = { ok: true } | { ok: false; response: NextResponse };

/**
 * 관리자 비밀번호를 확인합니다.
 * - ADMIN_PASSWORD 미설정 → 503 (설정 방법 안내)
 * - 비밀번호 없음/불일치 → 401
 */
export function requireAdmin(req: NextRequest): AdminCheck {
  const expected = (process.env.ADMIN_PASSWORD ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: ADMIN_ENV_HINT, needsEnv: true },
        { status: 503 },
      ),
    };
  }

  const given = adminKeyFrom(req);
  if (!given) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "관리자 비밀번호가 필요합니다." },
        { status: 401 },
      ),
    };
  }

  if (!sameSecret(given, expected)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "관리자 비밀번호가 올바르지 않습니다." },
        { status: 401 },
      ),
    };
  }

  return { ok: true };
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
