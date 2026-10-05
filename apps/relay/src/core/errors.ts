/** 可向客户端公开的业务错误；内部异常统一映射为 server-error。 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
