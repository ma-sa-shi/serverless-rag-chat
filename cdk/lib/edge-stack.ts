import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { AppStack } from "./app-stack";
import { DataStack } from "./data-stack";

export interface EdgeStackProps extends cdk.StackProps {
  appStack: AppStack;
  // CSPのconnect-srcにCognitoとドキュメントバケットのオリジンを載せる為に参照する
  dataStack: DataStack;
  // 代替ドメイン名と証明書は必ず対で必要な為、1つのプロパティにまとめる
  customDomain?: {
    domainName: string;
    certificate: acm.ICertificate;
  };
}

/**
 * 配信層スタック。
 * 単一のCloudFrontディストリビューションから、SPAの静的ファイルをS3へ、
 * `/api/*`をAPI Gatewayへ振り分ける。
 * SPA配信用バケットは、OACのバケットポリシーがディストリビューションARNを参照し
 * スタック間の循環参照になる為、DataStackではなく本スタックで保持する。
 */
export class EdgeStack extends cdk.Stack {
  public readonly spaBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { appStack, dataStack, customDomain } = props;

    // SPA静的ファイル配信用バケット。CloudFront OAC経由でのみ読み取れる
    this.spaBucket = new s3.Bucket(this, "SpaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // OACとバケットポリシー(cloudfront.amazonaws.comへのs3:GetObject許可)が自動生成される
    const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      this.spaBucket,
    );

    // どちらもAppStackの同一のREST APIを指す。
    // SSEとRESTでタイムアウト要件が異なる為、設定違いの2オリジンとして登録する

    // SSEのストリーミングを中断させない為のタイムアウト設定(設計書9.2)
    const chatOrigin = new origins.RestApiOrigin(appStack.restApi, {
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(20),
    });

    const apiOrigin = new origins.RestApiOrigin(appStack.restApi, {
      // api-fnのLambdaタイムアウトに合わせる
      readTimeout: cdk.Duration.seconds(30),
      keepaliveTimeout: cdk.Duration.seconds(20),
    });

    // アクセストークンはHttpOnly Cookieで届くが、API GatewayのCognitoオーソライザは
    // ヘッダーしか読めない為、Authorizationヘッダーへ写す(ADR-0018)。
    // Authorizationを既に持つリクエストは、そのトークンで検証させる
    const accessTokenFunction = new cloudfront.Function(
      this,
      "AccessTokenToAuthorization",
      {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var cookie = request.cookies['__Host-access_token'];
  if (cookie && !request.headers.authorization) {
    request.headers.authorization = { value: 'Bearer ' + cookie.value };
  }
  return request;
}
`),
      },
    );

    // APIレスポンスはキャッシュせず、CookieとAuthorizationヘッダー(Cognito JWT)を素通しする。
    // Authorizationは、API GatewayのCognitoオーソライザとFastAPIのJWT検証の両方が読む。
    // ALL_VIEWER_EXCEPT_HOST_HEADERはHostだけを落とす。
    // API GatewayはHostでAPIを識別する為、ビューワーのHostを転送すると到達できない
    const apiBehavior = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      functionAssociations: [
        {
          function: accessTokenFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };

    // React Routerのクライアントサイドルーティング用。
    // 拡張子を持たないパスをindex.htmlへ書き換える。
    // errorResponsesはディストリビューション全体に効き、FastAPIが返す403/404のJSONまで
    // index.html+200へ差し替えてしまう為、デフォルトビヘイビアだけに効く本Functionを使う
    const spaRouterFunction = new cloudfront.Function(this, "SpaRouter", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // 拡張子付き(=静的アセット)とルート以外はSPAのエントリポイントへ寄せる
  if (!uri.includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });

    // トークンをlocalStorageへ置く判断(ADR-0010)の緩和策。XSSが起きても外部へ送信させない。
    // SPAが同一オリジン外へ出す通信はこの3つだけで、他は全てCloudFront経由に収まる(設計書9.2)。
    // issuerの末尾の'/'は必須。CSPのパスは末尾がスラッシュのときだけ前方一致になり、
    // 付けないと完全一致となってoidc-client-tsが読む/.well-known配下が弾かれる
    const connectSources = [
      "'self'",
      `${dataStack.userPool.userPoolProviderUrl}/`,
      dataStack.userPoolDomain.baseUrl(),
      `https://${dataStack.documentsBucket.bucketRegionalDomainName}`,
    ];

    // object-src・base-uri・form-actionはdefault-srcのフォールバックが効かない為、個別に指定する
    const contentSecurityPolicy = [
      "default-src 'self'",
      `connect-src ${connectSources.join(" ")}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    const spaResponseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SpaResponseHeaders",
      {
        securityHeadersBehavior: {
          contentSecurityPolicy: { contentSecurityPolicy, override: true },
          // preloadはapexドメイン単位の登録になる為、サブドメイン配信の本システムでは付けない
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(730),
            includeSubdomains: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      },
    );

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: spaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // APIのJSONレスポンスにCSPは効かない為、SPAを返す本ビヘイビアにのみ適用する
        responseHeadersPolicy: spaResponseHeaders,
        functionAssociations: [
          {
            function: spaRouterFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // 定義順がそのままCloudFrontのビヘイビア優先順になる為、具体的なパスを先に置く
      additionalBehaviors: {
        // 圧縮はレスポンスをバッファリングしSSEのイベント到達を遅らせる為、無効にする
        "/api/chats/stream": {
          ...apiBehavior,
          origin: chatOrigin,
          compress: false,
        },
        "/api/*": { ...apiBehavior, origin: apiOrigin },
      },
      domainNames: customDomain ? [customDomain.domainName] : undefined,
      certificate: customDomain?.certificate,
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // 固定費ゼロの方針(ADR-0001)に沿ってエッジロケーションを絞る。日本を含む
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    new cdk.CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
    });
    new cdk.CfnOutput(this, "SpaBucketName", {
      value: this.spaBucket.bucketName,
    });
  }
}
