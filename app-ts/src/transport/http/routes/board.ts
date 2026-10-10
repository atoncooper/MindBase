import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import {
  BoardCompletionError,
  type BoardCompleteRequest,
  type BoardCompletionService,
  type BoardDirection,
} from "../../../services/board-completion.js";

const DIRECTIONS: BoardDirection[] = ["children", "siblings", "both"];

/**
 * Board AI routes — mounted under /chat so the existing nginx /chat/ and APISIX
 * chat routes carry them (a /board/* prefix would collide with the app-board
 * wildcard route). Port of app/routers/board_ai.py.
 *
 * Parameter validation + HTTP mapping only: the structured LLM call and the
 * board read via app-board-mcp live in services/board-completion.ts.
 */
export function registerBoardRoutes(
  app: FastifyInstance,
  deps: { completion: BoardCompletionService },
): void {
  app.post("/chat/board/complete", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (uid === undefined) {
      return reply.status(401).send({ detail: "未登录" });
    }
    const body = (req.body ?? {}) as Partial<BoardCompleteRequest>;
    if (!body.board_uuid || typeof body.board_uuid !== "string") {
      return reply.status(400).send({ detail: "board_uuid 不能为空" });
    }
    const direction = DIRECTIONS.includes(body.direction as BoardDirection)
      ? (body.direction as BoardDirection)
      : "both";
    try {
      return await deps.completion.complete(uid, {
        board_uuid: body.board_uuid,
        anchor_uid: typeof body.anchor_uid === "string" ? body.anchor_uid : "",
        anchor_text: typeof body.anchor_text === "string" ? body.anchor_text : "",
        direction,
      });
    } catch (err) {
      if (err instanceof BoardCompletionError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      throw err;
    }
  });
}
