import { Stack, StackProps, CfnOutput, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig, ORG } from './config';

// 환경 호스팅 영역(alm[-qa|-dev].pasapps.com). 환경 계정이 소유하고, 상위 pasapps.com(관리 계정)이 NS로 위임한다.
// 다른 환경 스택(Auth·App·Edge)이 인증서 검증·별칭·SES 레코드를 이 영역에 쓴다.
// 위임 전에는 인증서 검증이 끝나지 않으므로, 환경 첫 배포 전에 이 스택만 먼저 배포하고 위임한다(scripts/setup-dns.sh).
export class DnsStack extends Stack {
  readonly zone: route53.PublicHostedZone;
  /** 도메인 이전 1단계(cfg.legacyZoneName)에만: 옛 영역(alm-dev.bsgapps.com) */
  readonly legacyZone?: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    // 논리 ID 'AppZone': 2026-10 도메인 이전 때 옛 영역(논리 ID 'Zone')과 함께 있어야 해서 새 ID를 쓴다
    this.zone = new route53.PublicHostedZone(this, 'AppZone', {
      zoneName: cfg.zoneName, comment: `ALM ${cfg.name} (delegated from ${ORG.domain})`,
    });
    this.zone.applyRemovalPolicy(cfg.name === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
    new CfnOutput(this, 'ZoneId', { value: this.zone.hostedZoneId });
    new CfnOutput(this, 'NameServers', { value: Fn.join(',', this.zone.hostedZoneNameServers!) });

    if (cfg.legacyZoneName) {
      // 옛 영역: 속성을 이전과 똑같이 둬서 그대로 유지한다(옛 인증서가 검증용으로 가져다 씀).
      // 2단계에서 템플릿에서 빠질 때 CloudFormation이 지우지 않도록 RETAIN(인증서 검증 레코드가 남아 있으면 지우기가 실패한다)
      // → 2단계 뒤 scripts/cleanup-old-domain.sh로 정리
      this.legacyZone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: cfg.legacyZoneName, comment: `ALM ${cfg.name} (delegated from bsgapps.com)`,
      });
      this.legacyZone.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }
  }
}
