// 변경 이벤트(6.5, E-08: SNS → 제품별 SQS). 커밋 뒤 발행한다. 놓쳐도 제품 캐시 만료(60초)로 따라잡으므로 발행 실패는 로그만 남긴다
export type EventType = 'user.created' | 'user.updated' | 'user.deactivated' | 'assignment.changed' | 'tenant.updated';
export interface IdEvent { type: EventType; tenantId: string; tenantCode: string; userId?: string; product?: string }
export interface Publisher { publish(e: IdEvent[]): Promise<void> }

export class Events {
  readonly list: IdEvent[] = [];
  add(e: IdEvent) { if (!this.list.some((x) => JSON.stringify(x) === JSON.stringify(e))) this.list.push(e); }
}

export function snsPublisher(sns: { send(cmd: any): Promise<any> }, Cmd: any, topicArn: string | undefined, log = console): Publisher {
  return {
    async publish(events) {
      if (!topicArn) return;
      for (const e of events) {
        try {
          await sns.send(new Cmd({ TopicArn: topicArn, Message: JSON.stringify({ ...e, at: new Date().toISOString() }),
            MessageAttributes: { eventType: { DataType: 'String', StringValue: e.type },
              ...(e.product ? { product: { DataType: 'String', StringValue: e.product } } : {}) } }));
        } catch (err: any) { log.error(JSON.stringify({ msg: 'event publish failed', type: e.type, error: err?.name })); }
      }
    },
  };
}
