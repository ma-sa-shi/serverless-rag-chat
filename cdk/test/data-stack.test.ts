import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { normalizeAssetHashes } from './helpers';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new DataStack(app, 'TestDataStack');
  template = Template.fromStack(stack);
});

describe('DynamoDB', () => {
  test('Quotaの日次アイテムを自動削除するTTLが有効になっている', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('PK/SKのシングルテーブルがオンデマンドで作成される', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  test('横断一覧用のGSI1が定義される', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  test('スタック削除時にテーブルも削除される', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
    });
  });
});

describe('S3', () => {
  // SPA配信用バケットはOACのバケットポリシーと同居させる為EdgeStackが持つ
  test('ドキュメント保存用の1バケットが作成される', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('全バケットでパブリックアクセスをブロックする', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  test('ドキュメントバケットにpresigned PUT/GET用のCORSが設定される', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedMethods: ['PUT', 'GET'],
            // appDomain未指定時は配信ドメインが未確定の為、全オリジンを許可する
            AllowedOrigins: ['*'],
            AllowedHeaders: ['*'],
          },
        ],
      },
    });
  });
});

// EdgeStackを参照すると循環参照になる為、CloudFrontドメインはコンテキストで受け取る
describe('appDomainコンテキスト', () => {
  const appDomain = 'dxxxxxxxxxxxxx.cloudfront.net';
  let contextTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { appDomain } });
    contextTemplate = Template.fromStack(
      new DataStack(app, 'TestDataStackWithDomain'),
    );
  });

  test('CognitoのコールバックURLへCloudFrontドメインが追加される', () => {
    contextTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: [
        'http://localhost:5173/api/auth/callback',
        `https://${appDomain}/api/auth/callback`,
        'http://localhost:5173/auth/callback',
        `https://${appDomain}/auth/callback`,
      ],
      LogoutURLs: ['http://localhost:5173', `https://${appDomain}`],
    });
  });

  test('ドキュメントバケットのCORSがCloudFrontとローカル開発に絞られる', () => {
    contextTemplate.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedOrigins: [`https://${appDomain}`, 'http://localhost:5173'],
          }),
        ],
      },
    });
  });
});

describe('S3 Vectors', () => {
  test('ベクトルバケットが作成される', () => {
    template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
  });

  test('Cohere embed-v4.0向けのインデックスが作成される', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      VectorBucketArn: Match.anyValue(),
      DataType: 'float32',
      Dimension: 1536,
      DistanceMetric: 'cosine',
      MetadataConfiguration: {
        NonFilterableMetadataKeys: ['text', 'filename'],
      },
    });
  });
});

describe('SQS', () => {
  test('取込キューとDLQの2キューが作成される', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('取込キューはDLQへのリドライブと可視性タイムアウトを設定する', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 900,
      RedrivePolicy: {
        maxReceiveCount: 3,
        deadLetterTargetArn: Match.anyValue(),
      },
    });
  });

  test('DLQは14日間メッセージを保持する', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    });
  });
});

describe('監視', () => {
  test('DLQへ1件でも積まれたらアラームが発報する', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      // 取込が無い期間のデータ欠損でALARMにしない
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
      Dimensions: [
        {
          Name: 'QueueName',
          Value: {
            'Fn::GetAtt': [Match.stringLikeRegexp('IngestDeadLetterQueue'), 'QueueName'],
          },
        },
      ],
    });
  });

  test('通知先はalarmEmail未指定ならサブスクリプションを作らない', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('alarmEmail指定時はメールのサブスクリプションを作る', () => {
    const app = new cdk.App({ context: { alarmEmail: 'ops@example.com' } });
    const withEmail = Template.fromStack(new DataStack(app, 'TestDataStackWithEmail'));

    withEmail.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });
});

describe('Cognito', () => {
  test('セルフサインアップ無効・email/name必須のUser Poolが作成される', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'email', Required: true, Mutable: true }),
        Match.objectLike({ Name: 'name', Required: true, Mutable: true }),
      ]),
    });
  });

  test('スタック削除時にUser Poolも削除される', () => {
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Delete',
    });
  });

  test('Hosted UIドメインが作成される', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  test('SPAクライアントはシークレットなしのAuthorization Code + PKCEを設定する', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      // appDomain未指定時はローカル開発のURLのみ
      CallbackURLs: [
        'http://localhost:5173/api/auth/callback',
        'http://localhost:5173/auth/callback',
      ],
      LogoutURLs: ['http://localhost:5173'],
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  test('トークン有効期限はaccess/id 1時間、refresh 30日を設定する', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
    });
  });
});

test('スナップショット', () => {
  expect(normalizeAssetHashes(template)).toMatchSnapshot();
});
