// 앱 셸(openapi getMe). navCounts는 업무 화면(3.5 이후)이 생기면 채운다
import { Controller, Get } from '@nestjs/common';
import { toMe } from '../auth/login';
import { AlmContext, Ctx, Operation } from './context';

@Controller('me')
export class MeController {
  @Get()
  @Operation('getMe')
  getMe(@Ctx() ctx: AlmContext) {
    return toMe(ctx.principal!, { requests: 0, counts: 0, sap: 0 });
  }
}
