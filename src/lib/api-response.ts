import type { FastifyReply } from "fastify";

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export const sendSuccess = <T>(
  reply: FastifyReply,
  data: T,
  statusCode = 200,
): FastifyReply => {
  return reply.status(statusCode).send({
    ok: true,
    data,
  } satisfies ApiSuccess<T>);
};

export const sendError = (
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply => {
  const response: ApiError = {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };

  return reply.status(statusCode).send(response);
};
