// 오류 → application/problem+json(openapi Problem). 내부 오류의 세부 내용은 응답에 넣지 않고 로그에만 남긴다
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AlmError } from '../common/errors';
import { log } from '../common/log';
import { AlmRequest } from './context';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<AlmRequest>();
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = req.alm?.correlationId;
    let status = 500, code = 'ALM-E500', detail = '처리 중 오류가 발생했습니다';
    if (err instanceof AlmError) {
      ({ status, code } = err); detail = err.message;
      if (status >= 500) log.error(err.message, { code, correlationId, detail: err.detail });
      else if (err.detail) log.warn(err.message, { code, correlationId, detail: err.detail });
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = status === 404 ? 'ALM-E404' : status === 429 ? 'ALM-E429' : status < 500 ? 'ALM-E400' : 'ALM-E500';
      detail = status === 404 ? '찾을 수 없습니다' : err.message;
    } else {
      log.error('unhandled', { correlationId, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined });
    }
    res.status(status).type('application/problem+json').json({
      type: `https://alm.bsgapps.com/errors/${code}`, title: titleOf(status), status, code, detail, correlationId,
    });
  }
}

const titleOf = (s: number) => ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests' } as Record<number, string>)[s] ?? 'Internal Server Error';
