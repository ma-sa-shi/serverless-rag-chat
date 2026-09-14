import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";

// Vite devサーバー。デプロイ済みCognitoを使ってローカルで認証フローを動かす為に常に許可する
const LOCAL_ORIGIN = "http://localhost:5173";

/**
 * データ層スタック
 * DynamoDB(シングルテーブル構造)、S3バケット、S3 Vectors、ドキュメント取込用SQS、
 * Cognito User Pool（認証基盤）を構築・管理する
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly documentsBucket: s3.Bucket;
  public readonly vectorBucket: s3vectors.CfnVectorBucket;
  public readonly vectorIndex: s3vectors.CfnIndex;
  public readonly ingestQueue: sqs.Queue;
  public readonly ingestDeadLetterQueue: sqs.Queue;
  public readonly alarmTopic: sns.Topic;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SPAの公開ドメイン。DataStackからEdgeStackを参照すると循環参照になる為、
    // スタック間では渡さずコンテキストで受け取る(既定値はcdk.json)。
    // 独自ドメインの採用で値がデプロイ前に確定する為、再デプロイでの上書きは要らない(ADR-0013)
    const appDomain = this.node.tryGetContext("appDomain") as
      | string
      | undefined;
    const appUrl = appDomain ? `https://${appDomain}` : undefined;
    // ドキュメントのpresigned PUT/GETはローカル開発のSPAからも実行する
    const appOrigins = appUrl ? [appUrl, LOCAL_ORIGIN] : undefined;

    // Users / Documents / Chat / Chat Messages を1つのテーブルで管理(シングルテーブル)
    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // 日付ごとに積み上がるQuotaを自動で消す。他のエンティティはexpiresAtを持たず対象外
      timeToLiveAttribute: "expiresAt",
      // 開発環境前提の設定。本番運用へ移行する際はRETAIN + 削除保護 + PITRへ切り替える
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 全ユーザー横断での一覧取得用GSI（Chatは'GSI1PK=CHAT'、Documentは'GSI1PK=DOC'として共有利用）
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // SPA配信用バケットはEdgeStackが持つ
    // (OACのバケットポリシーがディストリビューションARNを参照する為、
    //  DataStackに置くとスタック間の循環参照になる)

    // RAG用ドキュメント保存用バケット（SPAから署名付きURLを利用して直接PUT/GETを実行）
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: appOrigins ?? ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    this.vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket");

    this.vectorIndex = new s3vectors.CfnIndex(this, "VectorIndex", {
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      dataType: "float32",
      // Cohere Embed v4(cohere.embed-v4:0)の次元数
      // 作成後に変更できない為、埋め込みモデルを変えるときはインデックスを作り直す
      dimension: 1536,
      distanceMetric: "cosine",
      metadataConfiguration: {
        // 作成後に変更できない
        // text=チャンク本文、filename=出典表示用
        // // フィルタリング対象のメタデータはdocumentIdのみ（データ書き込み時に付与）
        nonFilterableMetadataKeys: ["text", "filename"],
      },
    });

    // ドキュメント取込失敗時の退避用DLQ
    this.ingestDeadLetterQueue = new sqs.Queue(this, "IngestDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(14),
    });

    // ドキュメント取込非同期処理用Queue
    this.ingestQueue = new sqs.Queue(this, "IngestQueue", {
      // ingest-fnの最大実行時間（Lambdaの最大15分）に合わせた可視性タイムアウト設定
      visibilityTimeout: cdk.Duration.seconds(900),
      deadLetterQueue: {
        queue: this.ingestDeadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // 通知先メールは公開リポジトリへ残さない為、cdk.jsonではなくデプロイ時のコンテキストで受け取る。
    // 未指定ならトピックとアラームだけ作る(購読はマネジメントコンソールからでも追加できる)
    const alarmEmail = this.node.tryGetContext("alarmEmail") as
      | string
      | undefined;

    this.alarmTopic = new sns.Topic(this, "AlarmTopic");
    if (alarmEmail) {
      // 購読確認メールの承認は手動(cdk/README.md)
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alarmEmail),
      );
    }

    // DLQへ退避したメッセージは誰も見に行かない為、1件でも積まれたら通知する。
    // CloudWatchアラームの無料枠は10個であり、監視対象はこの1本に絞る
    this.ingestDeadLetterQueue
      .metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: cloudwatch.Stats.MAXIMUM,
      })
      .createAlarm(this, "IngestDeadLetterQueueAlarm", {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // 取込が無い期間はメトリクスが送られない。データ欠損をALARMにしない
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "ドキュメント取込がリトライ上限を超えてDLQへ退避した",
      })
      .addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    // Cognito ユーザープール設定
    // 運用形態: 管理者によるユーザー作成および招待メール送信の運用（セルフサインアップは無効化）
    // 詳細仕様は docs/authorization.md, ADR-0004を参照
    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        // 表示名。サインイン時にDynamoDBへキャッシュされる
        fullname: { required: true, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // prefixはグローバル一意制約がある為、AWSアカウントIDを付与して衝突を避ける
    this.userPoolDomain = this.userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: `event-driven-rag-${this.account}` },
    });

    // SPA用パブリッククライアント。Client Secret無し、Authorization Code Flow + PKCE
    this.userPoolClient = this.userPool.addClient("SpaClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        // profileは表示名(name)の取得に必要
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `${LOCAL_ORIGIN}/auth/callback`,
          ...(appUrl ? [`${appUrl}/auth/callback`] : []),
        ],
        logoutUrls: [LOCAL_ORIGIN, ...(appUrl ? [appUrl] : [])],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cdk.CfnOutput(this, "TableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value: this.documentsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "VectorBucketArn", {
      value: this.vectorBucket.attrVectorBucketArn,
    });
    new cdk.CfnOutput(this, "VectorIndexArn", {
      value: this.vectorIndex.attrIndexArn,
    });
    new cdk.CfnOutput(this, "IngestQueueUrl", {
      value: this.ingestQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: this.alarmTopic.topicArn });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
    // SPAのVITE_COGNITO_AUTHORITYとバックエンドのCOGNITO_ISSUERに使う
    new cdk.CfnOutput(this, "CognitoIssuer", {
      value: this.userPool.userPoolProviderUrl,
    });
  }
}
