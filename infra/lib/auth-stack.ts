import { Stack, StackProps, Duration, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { EnvConfig, ORG, fqdn } from './config';

export interface AuthProps extends StackProps { secretsKey: kms.IKey }

// 09 설계서 6장, 10 정의서 8.1: 환경별 사용자 풀 1개(Lite), 웹·PDA 앱 클라이언트, 리소스 서버.
// 고객사 IdP(T-<테넌트>)와 SAP 클라이언트는 테넌트 추가 때 alm-cognito-admin Lambda가 만든다(CDK 밖).
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly pdaClient: cognito.UserPoolClient;
  readonly webClientSecret: secrets.Secret;
  readonly cookieKeySecret: secrets.Secret;
  readonly resourceServerId = 'alm-api';
  readonly authCertificate: acm.Certificate;

  constructor(scope: Construct, id: string, cfg: EnvConfig, props: AuthProps) {
    super(scope, id, props);
    const appUrl = `https://${fqdn(cfg.appHost)}`;
    const authDomain = fqdn(cfg.authHost);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: ORG.hostedZoneId, zoneName: ORG.domain });

    this.userPool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `alm-${cfg.name}`,
      featurePlan: cognito.FeaturePlan.LITE,               // S-11
      selfSignUpEnabled: false,                            // 고객 사용자는 IdP로만 로그인
      signInAliases: { email: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,                                // MFA는 고객사 IdP 정책(09 6.2)
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      deletionProtection: cfg.name === 'prd',
      removalPolicy: cfg.name === 'prd' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const cert = this.authCertificate = new acm.Certificate(this, 'AuthCert', { domainName: authDomain, validation: acm.CertificateValidation.fromDns(zone) });
    const domain = this.userPool.addDomain('Domain', { customDomain: { domainName: authDomain, certificate: cert } });
    new route53.ARecord(this, 'AuthAlias', { zone, recordName: authDomain, target: route53.RecordTarget.fromAlias(new targets.UserPoolDomainTarget(domain)) });

    const sapScope = new cognito.ResourceServerScope({ scopeName: 'sap.api', scopeDescription: 'SAP 배치 연계' });
    this.userPool.addResourceServer('Api', { identifier: this.resourceServerId, scopes: [sapScope] });

    const oauthScopes = [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE];
    this.webClient = this.userPool.addClient('Web', {
      userPoolClientName: 'alm-web', generateSecret: true,
      authFlows: {}, oAuth: { flows: { authorizationCodeGrant: true }, scopes: oauthScopes,
        callbackUrls: [`${appUrl}/api/v1/auth/callback`], logoutUrls: [`${appUrl}/signed-out`] },
      accessTokenValidity: Duration.minutes(15), idTokenValidity: Duration.minutes(15), refreshTokenValidity: Duration.hours(8),
      enableTokenRevocation: true, preventUserExistenceErrors: true,
    });
    this.pdaClient = this.userPool.addClient('Pda', {
      userPoolClientName: 'alm-pda', generateSecret: false,
      authFlows: {}, oAuth: { flows: { authorizationCodeGrant: true }, scopes: oauthScopes,
        callbackUrls: ['com.bsg.alm://auth'], logoutUrls: ['com.bsg.alm://signed-out'] },
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60), refreshTokenValidity: Duration.hours(24),
      enableTokenRevocation: true, preventUserExistenceErrors: true,
    });

    // BFF가 쓰는 비밀(09 6.4): 웹 클라이언트 비밀, 리프레시 쿠키 암호화 키(분기 교체)
    // 키는 ARN으로 가져온다: 실제 키를 쓰면 App 실행 역할 권한이 Data 키 정책에 붙어 스택 순환이 생긴다.
    // 대신 App이 실행 역할에 kms:Decrypt(secretsmanager 경유)를 직접 준다
    const secretsKey = kms.Key.fromKeyArn(this, 'SecretsKeyRef', props.secretsKey.keyArn);
    this.webClientSecret = new secrets.Secret(this, 'WebClientSecret', {
      secretName: `alm/${cfg.name}/cognito-web-client`, encryptionKey: secretsKey,
      secretObjectValue: { clientId: SecretValue.unsafePlainText(this.webClient.userPoolClientId), clientSecret: this.webClient.userPoolClientSecret },
    });
    this.cookieKeySecret = new secrets.Secret(this, 'CookieKey', {
      secretName: `alm/${cfg.name}/cookie-key`, encryptionKey: secretsKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
  }
}
