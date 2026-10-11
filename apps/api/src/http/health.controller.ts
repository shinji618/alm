// ALB 상태 확인. DB를 보지 않는다(DB 장애 때 모든 작업이 교체되는 연쇄를 막음). ready는 DB까지 확인
import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from './context';
import { DB } from './tokens';
import { Db } from '../db/pool';

export const BUILD = process.env.BUILD_ID || 'local';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('live')
  @Public()
  live() { return { status: 'ok', build: BUILD }; }

  @Get('ready')
  @Public()
  async ready() {
    const t0 = Date.now();
    await this.db.query('SELECT 1');
    return { status: 'ok', build: BUILD, dbMs: Date.now() - t0 };
  }
}
