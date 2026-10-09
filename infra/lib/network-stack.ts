import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

// 10 정의서 4장: VPC 2개 가용 영역, 퍼블릭(NAT)·앱(사설)·데이터(격리) 서브넷
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `alm-${cfg.name}`,
      ipAddresses: ec2.IpAddresses.cidr(cfg.vpcCidr),
      availabilityZones: cfg.azs,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });

    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    if (cfg.interfaceEndpoints) {
      const svc = ec2.InterfaceVpcEndpointAwsService;
      const eps: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        EcrApi: svc.ECR, EcrDkr: svc.ECR_DOCKER, Logs: svc.CLOUDWATCH_LOGS,
        Secrets: svc.SECRETS_MANAGER, Sqs: svc.SQS, Kms: svc.KMS, Sts: svc.STS,
      };
      for (const [name, service] of Object.entries(eps)) {
        this.vpc.addInterfaceEndpoint(name, { service, subnets: { subnetGroupName: 'app' }, privateDnsEnabled: true });
      }
    }

    // 흐름 로그: PRD는 거부 트래픽만 90일(9.1). DEV·QA는 끔 → cdk-nag VPC7 예외(nag.ts)
    if (cfg.flowLogs) {
      const lg = new logs.LogGroup(this, 'FlowLogs', {
        logGroupName: `/alm/${cfg.name}/vpc-flow`, retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      this.vpc.addFlowLog('Reject', {
        destination: ec2.FlowLogDestination.toCloudWatchLogs(lg), trafficType: ec2.FlowLogTrafficType.REJECT,
      });
    }
  }
}
