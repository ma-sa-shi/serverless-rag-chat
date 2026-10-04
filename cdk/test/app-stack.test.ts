import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  AppStack,
  BEDROCK_ANSWER_MODEL,
  BEDROCK_EMBEDDING_MODEL,
  BEDROCK_RERANK_MODEL,
  BEDROCK_UTILITY_MODEL,
  CHAT_DAILY_QUOTA,
  LUNA_INFERENCE_PROFILE,
  METRICS_NAMESPACE,
} from '../lib/app-stack';
import { DataStack } from '../lib/data-stack';
import { normalizeAssetHashes } from './helpers';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const dataStack = new DataStack(app, 'TestDataStack');
  const appStack = new AppStack(app, 'TestAppStack', { dataStack });
  template = Template.fromStack(appStack);
});

// 環境変数からLambda論理リソースを特定するヘルパー
function findFunctionByServiceName(serviceName: string) {
  const functions = template.findResources('AWS::Lambda::Function');
  const matched = Object.entries(functions).filter(
    ([, fn]) =>
      fn.Properties.Environment?.Variables?.POWERTOOLS_SERVICE_NAME === serviceName,
  );
  expect(matched).toHaveLength(1);
  return matched[0];
}

describe('ECR', () => {
  test('CI/CD用の常設リポジトリが作成される', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResource('AWS::ECR::Repository', {
      Properties: { EmptyOnDelete: true },
      DeletionPolicy: 'Delete',
    });
  });

  test('Lambdaがイメージを取得できるリポジトリポリシーを持つ', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryPolicyText: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          }),
        ]),
      },
    });
  });
});

describe('Lambda', () => {
  test('3つのコンテナイメージLambdaが作成される', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.PackageType).toBe('Image');
    }
  });

  test('3関数ともarm64で実行される', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.Architectures).toEqual(['arm64']);
    }
  });

  test('api-fnは512MB/30秒でDataStackのリソース名を環境変数に持つ', () => {
    const [, fn] = findFunctionByServiceName('api');
    expect(fn.Properties.MemorySize).toBe(512);
    expect(fn.Properties.Timeout).toBe(30);
    const env = fn.Properties.Environment.Variables;
    expect(env).toHaveProperty('TABLE_NAME');
    expect(env).toHaveProperty('DOCUMENTS_BUCKET_NAME');
    expect(env).toHaveProperty('INGEST_QUEUE_URL');
    expect(env).toHaveProperty('VECTOR_INDEX_ARN');
    expect(env.POWERTOOLS_LOG_LEVEL).toBe('INFO');
  });

  test('api-fnとchat-fnはJWT検証用のCognito環境変数を持つ', () => {
    for (const serviceName of ['api', 'chat']) {
      const [, fn] = findFunctionByServiceName(serviceName);
      const env = fn.Properties.Environment.Variables;
      expect(env).toHaveProperty('COGNITO_ISSUER');
      expect(env).toHaveProperty('COGNITO_CLIENT_ID');
    }
    // HTTPリクエストを受けないingest-fnには不要
    const [, ingestFn] = findFunctionByServiceName('ingest');
    expect(ingestFn.Properties.Environment.Variables).not.toHaveProperty('COGNITO_ISSUER');
  });

  test('api-fnはサインインに使うHosted UIのドメインを持つ', () => {
    const [, fn] = findFunctionByServiceName('api');
    expect(fn.Properties.Environment.Variables).toHaveProperty('COGNITO_DOMAIN');
  });

  test('api-fnとchat-fnはappDomainコンテキストからアプリのオリジンを受け取る', () => {
    const app = new cdk.App({ context: { appDomain: 'rag.example.com' } });
    const dataStack = new DataStack(app, 'TestDataStackWithDomain');
    const appStack = new AppStack(app, 'TestAppStackWithDomain', { dataStack });
    const functions = Template.fromStack(appStack).findResources(
      'AWS::Lambda::Function',
    );
    const origins = Object.values(functions)
      .map((fn) => fn.Properties.Environment.Variables)
      .filter((env) => env.POWERTOOLS_SERVICE_NAME !== 'ingest')
      .map((env) => env.APP_ORIGIN);
    // Cognitoのリダイレクト先とCSRF検証の基準になる
    expect(origins).toEqual(['https://rag.example.com', 'https://rag.example.com']);
  });

  test('chat-fnは1024MB/300秒でストリーミングとBedrockのモデルIDを設定する', () => {
    const [, fn] = findFunctionByServiceName('chat');
    expect(fn.Properties.MemorySize).toBe(1024);
    expect(fn.Properties.Timeout).toBe(300);
    const env = fn.Properties.Environment.Variables;
    expect(env.AWS_LWA_INVOKE_MODE).toBe('response_stream');
    expect(env.BEDROCK_ANSWER_MODEL).toBe(BEDROCK_ANSWER_MODEL);
    expect(env.BEDROCK_UTILITY_MODEL).toBe(BEDROCK_UTILITY_MODEL);
    expect(env.BEDROCK_EMBEDDING_MODEL).toBe(BEDROCK_EMBEDDING_MODEL);
    expect(env.BEDROCK_RERANK_MODEL).toBe(BEDROCK_RERANK_MODEL);
    expect(env).toHaveProperty('VECTOR_BUCKET_ARN');
    expect(env).toHaveProperty('VECTOR_INDEX_ARN');
  });

  test('利用回数の上限はchat-fn(消費)とapi-fn(参照)の両方へ渡す', () => {
    for (const serviceName of ['chat', 'api']) {
      const [, fn] = findFunctionByServiceName(serviceName);
      expect(fn.Properties.Environment.Variables.CHAT_DAILY_QUOTA).toBe(
        CHAT_DAILY_QUOTA,
      );
    }
    const [, ingestFn] = findFunctionByServiceName('ingest');
    expect(ingestFn.Properties.Environment.Variables).not.toHaveProperty(
      'CHAT_DAILY_QUOTA',
    );
  });

  test('ingest-fnは1024MB/600秒でWeb Adapter用環境変数を持たない', () => {
    const [, fn] = findFunctionByServiceName('ingest');
    expect(fn.Properties.MemorySize).toBe(1024);
    expect(fn.Properties.Timeout).toBe(600);
    const env = fn.Properties.Environment.Variables;
    expect(env).not.toHaveProperty('AWS_LWA_INVOKE_MODE');
    // Embeddingはchat-fnの検索側と同じモデルを使う。LLMは呼ばない
    expect(env.BEDROCK_EMBEDDING_MODEL).toBe(BEDROCK_EMBEDDING_MODEL);
    expect(env).not.toHaveProperty('BEDROCK_ANSWER_MODEL');
    expect(env).toHaveProperty('DOCUMENTS_BUCKET_NAME');
    expect(env).toHaveProperty('VECTOR_INDEX_ARN');
  });

  test('3関数ともアクティブトレースとメトリクスの名前空間を持つ', () => {
    for (const serviceName of ['api', 'chat', 'ingest']) {
      const [, fn] = findFunctionByServiceName(serviceName);
      expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
      expect(fn.Properties.Environment.Variables.POWERTOOLS_METRICS_NAMESPACE).toBe(
        METRICS_NAMESPACE,
      );
    }
  });

  // 並行実行でX-Ray SDKのコンテキストが壊れる為、chat-fnだけアプリ内のトレース処理を止める(ADR-0014)
  test('chat-fnのみアプリ内トレースを無効化する', () => {
    const [, chatFn] = findFunctionByServiceName('chat');
    expect(chatFn.Properties.Environment.Variables.POWERTOOLS_TRACE_DISABLED).toBe('true');

    for (const serviceName of ['api', 'ingest']) {
      const [, fn] = findFunctionByServiceName(serviceName);
      expect(fn.Properties.Environment.Variables).not.toHaveProperty(
        'POWERTOOLS_TRACE_DISABLED',
      );
    }
  });

  test('3つのLambdaはそれぞれ別ターゲットのイメージを使う', () => {
    const imageUris = ['api', 'chat', 'ingest'].map((serviceName) =>
      JSON.stringify(findFunctionByServiceName(serviceName)[1].Properties.Code.ImageUri),
    );
    // web / chat / worker の3ターゲットに対応し、どれも共有しない
    expect(new Set(imageUris).size).toBe(3);
  });
});

describe('API Gateway', () => {
  // リソースの論理IDからパス(PathPart)を組み立てるヘルパー
  function resourcePaths() {
    const resources = template.findResources('AWS::ApiGateway::Resource');
    const paths: Record<string, string> = {};
    const pathOf = (logicalId: string): string => {
      const props = resources[logicalId].Properties;
      const parent = props.ParentId.Ref;
      // ParentIdがRestApiのRootResourceIdを指す場合はFn::GetAttになりRefを持たない
      return parent === undefined
        ? `/${props.PathPart}`
        : `${pathOf(parent)}/${props.PathPart}`;
    };
    for (const logicalId of Object.keys(resources)) {
      paths[logicalId] = pathOf(logicalId);
    }
    return paths;
  }

  // メソッドをパス文字列で引けるようにする
  function methodsByPath() {
    const paths = resourcePaths();
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    return new Map(
      methods.map((m) => [
        `${m.Properties.HttpMethod} ${paths[m.Properties.ResourceId.Ref]}`,
        m.Properties,
      ]),
    );
  }

  test('Function URLは作成されず、公開経路はREST APIだけになる(ADR-0011)', () => {
    template.resourceCountIs('AWS::Lambda::Url', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  // CloudFrontを前段に置く為、エッジ最適化ではなくリージョナル
  test('エンドポイントはリージョナル', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
  });

  test('FastAPIのルート構成に対応したリソースを持つ', () => {
    expect(new Set(Object.values(resourcePaths()))).toEqual(
      new Set([
        '/api',
        '/api/health',
        '/api/auth',
        '/api/auth/{proxy+}',
        '/api/chats',
        '/api/chats/stream',
        '/api/chats/{proxy+}',
        '/api/{proxy+}',
      ]),
    );
  });

  test('全メソッドがLambdaプロキシ統合で接続される', () => {
    for (const props of methodsByPath().values()) {
      expect(props.Integration.Type).toBe('AWS_PROXY');
      expect(props.Integration.IntegrationHttpMethod).toBe('POST');
    }
  });

  test('SSEのルートだけがchat-fnへストリーミングで統合される', () => {
    const methods = methodsByPath();
    const stream = methods.get('POST /api/chats/stream');
    expect(stream).toBeDefined();
    // STREAMを指定しないとレスポンス全体が揃うまで送出されない
    expect(stream.Integration.ResponseTransferMode).toBe('STREAM');

    for (const [key, props] of methods) {
      if (key === 'POST /api/chats/stream') continue;
      expect(props.Integration.ResponseTransferMode).toBeUndefined();
    }
  });

  test('統合タイムアウトが上限を超えない', () => {
    // 上限を超えるとデプロイがInvalidRequestで失敗する。
    // BUFFEREDはクォータ`Maximum integration timeout in milliseconds`(L-E5AE38E3)の
    // 既定値に縛られる。STREAMはクォータの対象外で、上限は15分となる
    const bufferedLimitMillis = 29_000;
    const streamLimitMillis = 900_000;
    for (const props of methodsByPath().values()) {
      const isStream = props.Integration.ResponseTransferMode === 'STREAM';
      const limit = isStream ? streamLimitMillis : bufferedLimitMillis;
      expect(props.Integration.TimeoutInMillis).toBeLessThanOrEqual(limit);
    }
  });

  test('SSEはchat-fn、それ以外はapi-fnへ振り分ける', () => {
    const methods = methodsByPath();
    const uriOf = (key: string) =>
      JSON.stringify(methods.get(key)!.Integration.Uri);
    const chatUri = uriOf('POST /api/chats/stream');
    const apiUri = uriOf('ANY /api/{proxy+}');
    expect(chatUri).not.toBe(apiUri);
    // chats配下のGETはapi-fnが処理する
    expect(uriOf('ANY /api/chats')).toBe(apiUri);
    expect(uriOf('ANY /api/chats/{proxy+}')).toBe(apiUri);
    expect(uriOf('GET /api/health')).toBe(apiUri);
    expect(uriOf('ANY /api/auth/{proxy+}')).toBe(apiUri);
  });

  test('Cognitoオーソライザが/api/healthと/api/auth以外の全ルートへ適用される', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      // FastAPIへ渡るBearerトークンと同じヘッダーをオーソライザも読む
      IdentitySource: 'method.request.header.Authorization',
    });

    for (const [key, props] of methodsByPath()) {
      // 更新は期限切れのアクセストークンしか持たない状態で呼ばれる(ADR-0018)
      if (key === 'GET /api/health' || key === 'ANY /api/auth/{proxy+}') {
        expect(props.AuthorizationType).toBe('NONE');
        expect(props.AuthorizerId).toBeUndefined();
      } else {
        expect(props.AuthorizationType).toBe('COGNITO_USER_POOLS');
        expect(props.AuthorizerId).toBeDefined();
        // 未指定だとオーソライザがIDトークンとして検証し、
        // アクセストークンを送る本システムでは全て401になる
        expect(props.AuthorizationScopes).toEqual(['openid']);
      }
    }
  });

  test('ステージでX-Rayのトレースが有効になる', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      TracingEnabled: true,
    });
  });

  test('ステージにスロットリングの上限が設定される', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'prod',
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: 20,
          ThrottlingBurstLimit: 40,
        }),
      ]),
    });
  });
});

describe('SQS', () => {
  test('ingest-fnは取込キューから1メッセージずつ受け取る', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      EventSourceArn: Match.anyValue(),
    });
  });
});

describe('IAM', () => {
  function policyStatements() {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
  }

  // 3関数がそれぞれS3 Vectorsの権限を持つ為、関数のロールに紐づくポリシーだけを見る
  function actionsGrantedTo(serviceName: string): string[] {
    const [, fn] = findFunctionByServiceName(serviceName);
    const roleLogicalId = fn.Properties.Role['Fn::GetAtt'][0];
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies)
      .filter((policy) =>
        policy.Properties.Roles.some(
          (role: { Ref: string }) => role.Ref === roleLogicalId,
        ),
      )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement) => statement.Action);
  }

  test('DynamoDBテーブルへの読み書き権限が付与される', () => {
    const statement = policyStatements().find(
      (s) => Array.isArray(s.Action) && s.Action.includes('dynamodb:PutItem'),
    );
    expect(statement).toBeDefined();
  });

  test('chat-fnにS3 Vectorsの検索権限が付与される', () => {
    const statement = policyStatements().find(
      (s) => Array.isArray(s.Action) && s.Action.includes('s3vectors:QueryVectors'),
    );
    expect(statement).toBeDefined();
    expect(statement.Action).toContain('s3vectors:GetVectors');
    expect(statement.Action).toContain('s3vectors:GetIndex');
  });

  test('ingest-fnにS3 Vectorsの登録・削除権限が付与される', () => {
    const statement = policyStatements().find(
      (s) => Array.isArray(s.Action) && s.Action.includes('s3vectors:PutVectors'),
    );
    expect(statement).toBeDefined();
    expect(statement.Action).toContain('s3vectors:DeleteVectors');
  });

  test('api-fnにはS3 Vectorsの削除権限だけが付与される', () => {
    const actions = actionsGrantedTo('api');
    expect(actions).toContain('s3vectors:DeleteVectors');
    expect(actions.filter((action) => action.startsWith('s3vectors:'))).toEqual([
      's3vectors:DeleteVectors',
    ]);
    // 原本の削除はドキュメントバケットのgrantReadWriteに含まれる
    expect(actions).toContain('s3:DeleteObject*');
  });

  test('APIキーのSSMパラメータは参照しない', () => {
    const statements = policyStatements().filter(
      (s) => JSON.stringify(s.Action).includes('ssm:'),
    );
    expect(statements).toEqual([]);
  });

  test('chat-fnにBedrockの推論権限が回答モデルとリランクへ付与される', () => {
    const chatActions = actionsGrantedTo('chat');
    // SSEはノード単位の更新を配信する為、トークンストリーミングの権限は持たない
    expect(chatActions).not.toContain('bedrock:InvokeModelWithResponseStream');
    const statement = policyStatements().find(
      (s) =>
        Array.isArray(s.Resource) &&
        JSON.stringify(s.Resource).includes('inference-profile/'),
    );
    expect(statement).toBeDefined();
    expect(statement.Action).toBe('bedrock:InvokeModel');
    const resources = JSON.stringify(statement.Resource);
    // 推論プロファイル経由のモデルは、プロファイルと配下の基盤モデルの双方の許可が要る
    expect(resources).toContain(`inference-profile/${BEDROCK_ANSWER_MODEL}`);
    expect(resources).toContain(`inference-profile/${BEDROCK_UTILITY_MODEL}`);
    expect(resources).toContain('arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0');
    // 回答生成と補助に同じモデルを充てているため、ARNは重複しない
    expect(new Set(statement.Resource).size).toBe(statement.Resource.length);
    // gpt-5.6-luna開放後に環境変数だけで戻せるよう権限を残す
    expect(resources).toContain(`inference-profile/${LUNA_INFERENCE_PROFILE}`);
    expect(resources).toContain('arn:aws:bedrock:*::foundation-model/openai.gpt-5.6-luna');
    expect(resources).toContain(`foundation-model/${BEDROCK_EMBEDDING_MODEL}`);
    expect(resources).toContain(`foundation-model/${BEDROCK_RERANK_MODEL}`);
    expect(chatActions).toContain('bedrock:Rerank');
  });

  test('ingest-fnにはEmbeddingモデルの推論権限だけが付与される', () => {
    const actions = actionsGrantedTo('ingest').filter((action: string) =>
      action.startsWith('bedrock:'),
    );
    expect(actions).toEqual(['bedrock:InvokeModel']);
    const statement = policyStatements().find(
      (s) =>
        s.Action === 'bedrock:InvokeModel' && !Array.isArray(s.Resource),
    );
    expect(JSON.stringify(statement.Resource)).toContain(
      `foundation-model/${BEDROCK_EMBEDDING_MODEL}`,
    );
  });

  test('api-fnにはBedrockの権限が付与されない', () => {
    expect(
      actionsGrantedTo('api').filter((action: string) => action.startsWith('bedrock:')),
    ).toEqual([]);
  });

  test('api-fnにSQS送信権限、ingest-fnにSQS消費権限が付与される', () => {
    const statements = policyStatements();
    expect(
      statements.find((s) => Array.isArray(s.Action) && s.Action.includes('sqs:SendMessage')),
    ).toBeDefined();
    expect(
      statements.find(
        (s) => Array.isArray(s.Action) && s.Action.includes('sqs:ReceiveMessage'),
      ),
    ).toBeDefined();
  });
});

test('スナップショット', () => {
  expect(normalizeAssetHashes(template)).toMatchSnapshot();
});
