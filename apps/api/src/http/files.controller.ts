// 첨부 업로드·다운로드 URL(openapi presignAttachment·downloadAttachment). 실제 파일은 브라우저가 S3와 직접 주고받는다
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { Db } from '../db/pool';
import { Config } from '../config';
import { AlmError } from '../common/errors';
import { UUID } from '../common/validate';
import { completeWeb, downloadUrl, FileStore, presignWeb, removeWeb } from '../files/files';
import { AlmContext, Ctx, Operation, txOf } from './context';
import { CONFIG, DB, FILES } from './tokens';

export function needStore(files: FileStore | null): FileStore {
  if (!files) throw new AlmError(503, 'ALM-E500', '첨부 저장소가 설정되지 않았습니다(FILES_BUCKET)');
  return files;
}

@Controller()
export class FilesController {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(FILES) private files: FileStore | null) {}

  // 경로의 ':'는 Express 5 경로 문법에서 매개변수 표시라 '\\:'로 쓴다(/attachments:presign)
  @Post('attachments\\:presign')
  @HttpCode(200)
  @Operation('presignAttachment')
  presign(@Ctx() ctx: AlmContext, @Body() body: unknown) {
    const store = needStore(this.files);
    return this.db.withTx(txOf(ctx), (c) => presignWeb(c, store, ctx.principal!, body));
  }

  @Post('attachments/:id\\:complete')
  @HttpCode(200)
  @Operation('completeAttachment')
  complete(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    const store = needStore(this.files);
    if (!UUID.test(id)) throw new AlmError(404, 'ALM-E404', '첨부를 찾을 수 없습니다');
    return this.db.withTx(txOf(ctx), (c) => completeWeb(c, store, ctx.principal!, id));
  }

  @Get('attachments/:id\\:download')
  @Operation('downloadAttachment')
  download(@Ctx() ctx: AlmContext, @Param('id') id: string, @Query('inline') inline?: string) {
    const store = needStore(this.files);
    if (!UUID.test(id)) throw new AlmError(404, 'ALM-E404', '첨부를 찾을 수 없습니다');
    return this.db.withTx(txOf(ctx), (c) => downloadUrl(c, store, ctx.principal!, id, !!this.cfg.filesScanRequired, new Date(), inline === 'true'));
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  @Operation('deleteAttachment')
  async remove(@Ctx() ctx: AlmContext, @Param('id') id: string) {
    const store = needStore(this.files);
    if (!UUID.test(id)) throw new AlmError(404, 'ALM-E404', '첨부를 찾을 수 없습니다');
    await this.db.withTx(txOf(ctx), (c) => removeWeb(c, store, ctx.principal!, id));
  }
}
