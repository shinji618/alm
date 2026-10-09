import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { EnvConfig, ORG, fqdn, logBucketName } from './config';

export interface EdgeProps extends StackProps {
  alb: elbv2.IApplicationLoadBalancer;
  albSecurityGroup: ec2.ISecurityGroup;
  certificate: acm.ICertificate;
  vpc: ec2.IVpc;
}

// 10 정의서 5장: CloudFront(웹 S3 + /api/* VPC 오리진), WAF, 응답 헤더, DNS
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly webBucket: s3.Bucket;
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: EdgeProps) {
    super(scope, id, props);
    const env = cfg.name;
    const appDomain = fqdn(cfg.appHost);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: ORG.hostedZoneId, zoneName: ORG.domain });

    this.webBucket = new s3.Bucket(this, 'Web', {
      bucketName: `alm-${env}-web-${this.account}`, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.webBucket);

    // SPA 라우팅: 확장자 없는 경로 → /index.html (배포 전체 오류 응답은 /api/*를 망가뜨리므로 쓰지 않음)
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      functionName: `alm-${env}-spa-rewrite`, runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event){var r=event.request;var u=r.uri;if(u.indexOf('.')===-1){r.uri='/index.html';}return r;}"),
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: `alm-${env}-security`,
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        contentSecurityPolicy: { override: true, contentSecurityPolicy: [
          "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://*.amazonaws.com",
          "font-src 'self'", `connect-src 'self' https://${fqdn(cfg.authHost)} https://*.s3.${this.region}.amazonaws.com http://localhost:9100 https://localhost:9101`,
          "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; ') },
      },
    });

    const apiOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      domainName: appDomain,                       // Host = 앱 도메인 → ALB 인증서와 일치
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(60), keepaliveTimeout: Duration.seconds(5),
    });

    this.webAcl = this.buildWaf(cfg);
    // WAF 로그: 이름이 aws-waf-logs- 로 시작해야 한다. 토큰·쿠키는 가린다(09 10장)
    const wafLogs = new logs.LogGroup(this, 'WafLogs', { logGroupName: `aws-waf-logs-alm-${env}`,
      retention: logs.RetentionDays.ONE_YEAR, removalPolicy: env === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [`arn:aws:logs:${this.region}:${this.account}:log-group:${wafLogs.logGroupName}`],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }],
    }).node.addDependency(wafLogs);

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `ALM ${env}`, domainNames: [appDomain], certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021, httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, webAclId: this.webAcl.attrArn, defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: webOrigin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/assets/*': { origin: webOrigin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, responseHeadersPolicy: headers },
        '/api/*': { origin: apiOrigin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022, responseHeadersPolicy: headers },
      },
    });

    new route53.ARecord(this, 'Alias', { zone, recordName: appDomain, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)) });
    new route53.AaaaRecord(this, 'AliasV6', { zone, recordName: appDomain, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)) });

    // CloudFront 표준 로그 v2 → log-archive 버킷(ACL 불필요)
    const src = new logs.CfnDeliverySource(this, 'CdnLogSource', { name: `alm-${env}-cdn`, logType: 'ACCESS_LOGS', resourceArn: this.distribution.distributionArn });
    const dst = new logs.CfnDeliveryDestination(this, 'CdnLogDest', { name: `alm-${env}-cdn-s3`,
      destinationResourceArn: `arn:aws:s3:::${logBucketName(env)}/cloudfront`, outputFormat: 'parquet' });
    const delivery = new logs.CfnDelivery(this, 'CdnLogDelivery', { deliverySourceName: src.name, deliveryDestinationArn: dst.attrArn });
    delivery.addResourceDependency(src);

    // ALB 보안 그룹: AWS가 VPC 오리진용으로 만드는 'CloudFront-VPCOrigins-Service-SG'에서 443만 허용
    const lookup = new cr.AwsCustomResource(this, 'VpcOriginSgLookup', {
      onUpdate: { service: 'EC2', action: 'describeSecurityGroups', physicalResourceId: cr.PhysicalResourceId.of(`alm-${env}-vpc-origin-sg`),
        parameters: { Filters: [{ Name: 'vpc-id', Values: [props.vpc.vpcId] }, { Name: 'group-name', Values: ['CloudFront-VPCOrigins-Service-SG'] }] },
        outputPaths: ['SecurityGroups.0.GroupId'] },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
    });
    lookup.node.addDependency(this.distribution);
    new ec2.CfnSecurityGroupIngress(this, 'AlbFromCloudFront', {
      groupId: props.albSecurityGroup.securityGroupId, ipProtocol: 'tcp', fromPort: 443, toPort: 443,
      sourceSecurityGroupId: lookup.getResponseField('SecurityGroups.0.GroupId'), description: 'CloudFront VPC origin',
    });
  }

  // 10 정의서 5.2
  private buildWaf(cfg: EnvConfig): wafv2.CfnWebACL {
    const env = cfg.name;
    const sapIps = new wafv2.CfnIPSet(this, 'SapIps', { name: `alm-${env}-sap`, scope: 'CLOUDFRONT', ipAddressVersion: 'IPV4', addresses: cfg.sapEgressCidrs });
    const custIps = new wafv2.CfnIPSet(this, 'CustomerIps', { name: `alm-${env}-customer-egress`, scope: 'CLOUDFRONT', ipAddressVersion: 'IPV4', addresses: cfg.customerEgressCidrs });
    const vis = (name: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `alm-${env}-${name}` });
    const lower = [{ priority: 0, type: 'LOWERCASE' }];
    const sapPath: wafv2.CfnWebACL.StatementProperty = { orStatement: { statements: [
      { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: '/api/v1/sap/', textTransformations: lower } },
      { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', searchString: '/api/v1/oauth/token', textTransformations: lower } },
    ] } };
    const inSap = { ipSetReferenceStatement: { arn: sapIps.attrArn } };
    const notSapLabel = { notStatement: { statement: { labelMatchStatement: { scope: 'LABEL', key: 'alm:sap' } } } };
    const managed = (name: string, priority: number, scopeDown?: object, overrides?: string[]) => ({
      name, priority, overrideAction: { none: {} }, visibilityConfig: vis(name),
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ...(scopeDown ? { scopeDownStatement: scopeDown } : {}),
        ...(overrides ? { ruleActionOverrides: overrides.map((n) => ({ name: n, actionToUse: { count: {} } })) } : {}) } },
    });
    return new wafv2.CfnWebACL(this, 'Waf', {
      name: `alm-${env}`, scope: 'CLOUDFRONT', defaultAction: { allow: {} }, visibilityConfig: vis('acl'),
      rules: [
        { name: 'sap-allowlist-block', priority: 0, action: { block: {} }, visibilityConfig: vis('sap-block'),
          statement: { andStatement: { statements: [sapPath, { notStatement: { statement: inSap } }] } } },
        { name: 'sap-label', priority: 1, action: { count: {} }, ruleLabels: [{ name: 'alm:sap' }], visibilityConfig: vis('sap-label'),
          statement: { andStatement: { statements: [sapPath, inSap] } } },
        managed('AWSManagedRulesAmazonIpReputationList', 2),
        managed('AWSManagedRulesAnonymousIpList', 3, notSapLabel),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 4),
        // 본문 크기 규칙은 PDA 배치·SAP 본문(최대 10MB) 때문에 count로 낮춘다
        managed('AWSManagedRulesCommonRuleSet', 5, notSapLabel, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesSQLiRuleSet', 6, notSapLabel),
        { name: 'rate-ip', priority: 7, action: { block: {} }, visibilityConfig: vis('rate-ip'),
          statement: { rateBasedStatement: { limit: 2000, evaluationWindowSec: 300, aggregateKeyType: 'IP',
            scopeDownStatement: { notStatement: { statement: { ipSetReferenceStatement: { arn: custIps.attrArn } } } } } } },
        { name: 'rate-login', priority: 8, action: { block: {} }, visibilityConfig: vis('rate-login'),
          statement: { rateBasedStatement: { limit: 300, evaluationWindowSec: 300, aggregateKeyType: 'IP',
            scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: '/api/v1/auth/login', textTransformations: lower } } } } },
      ],
    });
  }
}
