import { Stack, StackProps, CfnOutput, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig, ORG } from './config';

// 환경 호스팅 영역(alm[-qa|-dev].bsgapps.com). 환경 계정이 소유하고, 상위 bsgapps.com(관리 계정)이 NS로 위임한다.
// 다른 환경 스택(Auth·App·Edge)이 인증서 검증·별칭·SES 레코드를 이 영역에 쓴다.
// 위임 전에는 인증서 검증이 끝나지 않으므로, 환경 첫 배포 전에 이 스택만 먼저 배포하고 위임한다(scripts/delegate-zones.sh).
export class DnsStack extends Stack {
  readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);
    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: cfg.zoneName, comment: `ALM ${cfg.name} (delegated from ${ORG.domain})`,
    });
    this.zone.applyRemovalPolicy(cfg.name === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
    new CfnOutput(this, 'ZoneId', { value: this.zone.hostedZoneId });
    new CfnOutput(this, 'NameServers', { value: Fn.join(',', this.zone.hostedZoneNameServers!) });
  }
}
