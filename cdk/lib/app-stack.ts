import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { DataStack } from "./data-stack";

// 推論はすべてBedrock経由で行う(ADR-0016)。モデルアクセスの有効化は手動作業であり、
// 手順はcdk/README.mdに記載
export const BEDROCK_ANSWER_MODEL = "jp.amazon.nova-2-lite-v1:0";
export const BEDROCK_UTILITY_MODEL = "jp.amazon.nova-2-lite-v1:0";
export const BEDROCK_EMBEDDING_MODEL = "cohere.embed-v4:0";
export const BEDROCK_RERANK_MODEL = "cohere.rerank-v3-5:0";

// 1ユーザーが1日に送れるチャット数。1チャット約$0.006の実測が根拠(ADR-0017)
export const CHAT_DAILY_QUOTA = "20";
// 第一候補のgpt-5.6-lunaはアカウントで未開放のため暫定の2モデルで動かす。
// 開放後に環境変数だけで戻せるよう、lunaの権限も併せて付与しておく(ADR-0016)
export const LUNA_INFERENCE_PROFILE = "global.openai.gpt-5.6-luna";

// 推論プロファイル経由でしか呼べないモデルがある。IAMではプロファイルと、
// その配下の基盤モデルの双方を許可しなければ呼び出しが拒否される
const INFERENCE_PROFILE_PREFIXES = ["global.", "apac.", "jp.", "us.", "eu."];

function modelArns(stack: cdk.Stack, modelId: string): string[] {
  const prefix = INFERENCE_PROFILE_PREFIXES.find((p) => modelId.startsWith(p));
  if (prefix === undefined) {
    return [`arn:aws:bedrock:${stack.region}::foundation-model/${modelId}`];
  }
  const foundationModel = modelId.slice(prefix.length);
  return [
    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
    // globalプロファイルは任意のリージョンへ振り分ける為、基盤モデル側はリージョンを絞れない
    `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
  ];
}

// BUFFEREDの統合のタイムアウト上限は、サービスクォータ
// `Maximum integration timeout in milliseconds`(L-E5AE38E3)で決まる。既定は29秒である。
// api-fnのLambdaタイムアウトは30秒だが、統合側は上限の29秒で打ち切る
export const API_INTEGRATION_TIMEOUT = cdk.Duration.seconds(29);
// ResponseTransferModeがSTREAMの統合は上記クォータの対象外で、最大15分まで設定できる。
// SSEはストリーム全体が統合タイムアウトに収まる必要があるため、chat-fnのLambdaタイムアウトに合わせる
export const CHAT_INTEGRATION_TIMEOUT = cdk.Duration.seconds(300);

// CloudWatchのカスタムメトリクスの名前空間。発行するメトリクスはarchitecture.md 10.1を参照
export const METRICS_NAMESPACE = "EventDrivenRag";

export interface AppStackProps extends cdk.StackProps {
  dataStack: DataStack;
}

/**
 * アプリケーション層スタック。
 * 単一のbackendコードベースを責務別に3つのコンテナLambda
 * (api-fn / chat-fn / ingest-fn)としてデプロイする(ADR-0003)。
 */
export class AppStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly apiFunction: lambda.DockerImageFunction;
  public readonly chatFunction: lambda.DockerImageFunction;
  public readonly ingestFunction: lambda.DockerImageFunction;
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { dataStack } = props;

    // CI/CD用の常設リポジトリ
    // CIが build → push → update-function-code で使う
    // 現時点のLambdaは下記のイメージアセット(bootstrapのアセットリポジトリ)を参照する
    this.repository = new ecr.Repository(this, "Repository", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // bootstrapのアセットリポジトリと違い、常設リポジトリのポリシーは自分で用意する。
    // Lambdaはポリシーが無い場合に自動追加を試みるが、それにはデプロイ用ロールへ
    // ecr:GetRepositoryPolicy / SetRepositoryPolicyが要る為、明示的に付ける
    this.repository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "LambdaECRImageRetrievalPolicy",
        principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        // サービスプリンシパルを自アカウントの関数へ限定する
        conditions: {
          ArnLike: {
            "aws:sourceARN": this.formatArn({
              service: "lambda",
              resource: "function",
              resourceName: "*",
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );

    const backendPath = path.join(__dirname, "..", "..", "apps", "backend");

    // イメージのplatformとFunctionのarchitectureは連動しない為、両方をarm64で揃える。
    // 食い違うとデプロイしたイメージをLambdaが起動できない

    // web: Lambda Web Adapter + uvicorn(api-fn)
    const webImage = lambda.DockerImageCode.fromImageAsset(backendPath, {
      target: "web",
      platform: Platform.LINUX_ARM64,
    });

    // chat: webにLangGraph / LangChainを追加した構成(chat-fn)。
    // RAG関連ライブラリはイメージサイズが大きくapi-fnのコールドスタートを長くする為、分離する
    const chatImage = lambda.DockerImageCode.fromImageAsset(backendPath, {
      target: "chat",
      platform: Platform.LINUX_ARM64,
    });
    // worker: awslambdaricによる軽量ハンドラ構成(ingest-fn)
    const workerImage = lambda.DockerImageCode.fromImageAsset(backendPath, {
      target: "worker",
      platform: Platform.LINUX_ARM64,
    });

    // 回答生成と補助に同じモデルを充てているため重複する
    const llmModelArns = [
      ...new Set([
        ...modelArns(this, BEDROCK_ANSWER_MODEL),
        ...modelArns(this, BEDROCK_UTILITY_MODEL),
        ...modelArns(this, LUNA_INFERENCE_PROFILE),
      ]),
    ];
    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/${BEDROCK_EMBEDDING_MODEL}`;
    const rerankModelArn = `arn:aws:bedrock:${this.region}::foundation-model/${BEDROCK_RERANK_MODEL}`;

    // --- REST API Lambda (api-fn) ---
    // 認証、一覧、presigned URL発行、取込開始のSQS送信
    this.apiFunction = new lambda.DockerImageFunction(this, "ApiFunction", {
      code: webImage,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // X-Rayのセグメントを記録する。トレースは従量課金であり固定費は増えない(ADR-0001)
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: dataStack.table.tableName,
        DOCUMENTS_BUCKET_NAME: dataStack.documentsBucket.bucketName,
        INGEST_QUEUE_URL: dataStack.ingestQueue.queueUrl,
        VECTOR_INDEX_ARN: dataStack.vectorIndex.attrIndexArn,
        COGNITO_ISSUER: dataStack.userPool.userPoolProviderUrl,
        COGNITO_CLIENT_ID: dataStack.userPoolClient.userPoolClientId,
        CHAT_DAILY_QUOTA,
        POWERTOOLS_SERVICE_NAME: "api",
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      },
    });

    dataStack.table.grantReadWriteData(this.apiFunction);
    // 署名付きURLはLambdaロールの権限で署名される為、発行対象の操作権限が必要
    dataStack.documentsBucket.grantReadWrite(this.apiFunction);
    dataStack.ingestQueue.grantSendMessages(this.apiFunction);
    // ドキュメント削除でベクトルを消すだけで、登録や検索は行わない
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:DeleteVectors"],
        resources: [dataStack.vectorIndex.attrIndexArn],
      }),
    );

    // --- チャット Lambda (chat-fn) ---
    // LangGraph Self-RAGによるSSEストリーミングチャット
    this.chatFunction = new lambda.DockerImageFunction(this, "ChatFunction", {
      code: chatImage,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(300),
      // Lambda自身のセグメントは記録する。アプリ内のトレース処理のみ環境変数で止める(ADR-0014)
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: dataStack.table.tableName,
        VECTOR_BUCKET_ARN: dataStack.vectorBucket.attrVectorBucketArn,
        VECTOR_INDEX_ARN: dataStack.vectorIndex.attrIndexArn,
        COGNITO_ISSUER: dataStack.userPool.userPoolProviderUrl,
        COGNITO_CLIENT_ID: dataStack.userPoolClient.userPoolClientId,
        BEDROCK_ANSWER_MODEL,
        BEDROCK_UTILITY_MODEL,
        BEDROCK_EMBEDDING_MODEL,
        BEDROCK_RERANK_MODEL,
        CHAT_DAILY_QUOTA,
        // 統合のResponseTransferMode STREAMとセットで必要(片方のみではバッファリングされる)
        AWS_LWA_INVOKE_MODE: "response_stream",
        POWERTOOLS_SERVICE_NAME: "chat",
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        // RAGパイプラインはベクトル検索を並行実行し、X-Ray SDKのスレッドローカルな
        // コンテキストが壊れる。サブセグメントが失われるだけでなく、LLM呼び出しへ
        // 例外が漏れて再試行を招く為、アプリ内のトレース処理は行わない(ADR-0014)
        POWERTOOLS_TRACE_DISABLED: "true",
      },
    });

    dataStack.table.grantReadWriteData(this.chatFunction);
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:QueryVectors",
          "s3vectors:GetVectors",
        ],
        resources: [dataStack.vectorIndex.attrIndexArn],
      }),
    );
    // SSEはノード単位のstate更新を配信する為、LLMのトークンストリーミングは使わない。
    // InvokeModelWithResponseStreamは付与しない
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [...llmModelArns, embeddingModelArn, rerankModelArn],
      }),
    );
    // Rerankはモデルではなくアクション単位で許可する。実際に使えるモデルは上のInvokeModelで絞る
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Rerank"],
        resources: ["*"],
      }),
    );

    // --- ドキュメント取込 Worker Lambda (ingest-fn) ---
    // テキスト抽出 → チャンク分割 → embedding → S3 Vectors登録(SQSトリガー)
    this.ingestFunction = new lambda.DockerImageFunction(
      this,
      "IngestFunction",
      {
        code: workerImage,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        // SQSの可視性タイムアウト900秒以内に収める
        timeout: cdk.Duration.seconds(600),
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          TABLE_NAME: dataStack.table.tableName,
          DOCUMENTS_BUCKET_NAME: dataStack.documentsBucket.bucketName,
          VECTOR_BUCKET_ARN: dataStack.vectorBucket.attrVectorBucketArn,
          VECTOR_INDEX_ARN: dataStack.vectorIndex.attrIndexArn,
          BEDROCK_EMBEDDING_MODEL,
          POWERTOOLS_SERVICE_NAME: "ingest",
          POWERTOOLS_LOG_LEVEL: "INFO",
          POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        },
      },
    );

    // 1ドキュメントの処理が長いため1メッセージずつ起動する
    this.ingestFunction.addEventSource(
      new SqsEventSource(dataStack.ingestQueue, { batchSize: 1 }),
    );

    dataStack.table.grantReadWriteData(this.ingestFunction);
    dataStack.documentsBucket.grantRead(this.ingestFunction);
    this.ingestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:PutVectors",
          // 再取込でチャンク数が減ったときの余剰ベクトル削除用
          "s3vectors:DeleteVectors",
        ],
        resources: [dataStack.vectorIndex.attrIndexArn],
      }),
    );
    this.ingestFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [embeddingModelArn],
      }),
    );

    // --- API Gateway ---
    // api-fnとchat-fnの唯一の公開経路。CloudFrontの`/api/*`のオリジンになる。
    // CloudFrontのみを許可するリソースポリシーは張らず、
    // 直接アクセスはオーソライザとスロットリングでLambda起動前に止める(ADR-0011)
    this.restApi = new apigateway.RestApi(this, "RestApi", {
      // CloudFrontを前段に置く為、エッジ最適化ではなくリージョナルにする
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: "prod",
        // Lambdaのセグメントとつなげ、サービスマップをAPI Gatewayから始める
        tracingEnabled: true,
        // 想定は月400〜600チャットであり、通常利用が当たる水準ではない
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
    });

    // Lambda起動前にJWTを検証する。FastAPI側の検証は残し、認可(誰のデータか)はアプリで行う(ADR-0004)
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [dataStack.userPool] },
    );
    const authorized: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      // Cognitoオーソライザは既定でIDトークンとして検証する為、
      // アクセストークンを送る本システムでは指定しないと全て401になる。
      // authorizationScopesを指定するとアクセストークンのscopeクレームで検証する。
      // SPAが要求するスコープはopenid / email / profileであり、共通するopenidを要求する
      authorizationScopes: ["openid"],
    };

    const apiIntegration = new apigateway.LambdaIntegration(this.apiFunction, {
      timeout: API_INTEGRATION_TIMEOUT,
    });
    // SSEはSTREAMを指定しないとレスポンス全体が揃うまで送出されない
    const chatIntegration = new apigateway.LambdaIntegration(
      this.chatFunction,
      {
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        timeout: CHAT_INTEGRATION_TIMEOUT,
      },
    );

    // FastAPIのルートは全て`/api`配下にある(CloudFrontの`/api/*`と一致させる為)
    const apiResource = this.restApi.root.addResource("api");

    // ヘルスチェックは無認証。オーソライザを付けない唯一のルート
    apiResource.addResource("health").addMethod("GET", apiIntegration);

    // `/api/chats`直下にchat-fnとapi-fnの両方のルートがある為、
    // `/api/{proxy+}`だけでは足りず、chats配下を明示的に分岐させる。
    // API Gatewayはグリーディパスより具体的なリソースを優先する
    const chats = apiResource.addResource("chats");
    chats.addResource("stream").addMethod("POST", chatIntegration, authorized);
    chats.addMethod("ANY", apiIntegration, authorized);
    chats.addResource("{proxy+}").addMethod("ANY", apiIntegration, authorized);

    apiResource
      .addResource("{proxy+}")
      .addMethod("ANY", apiIntegration, authorized);

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: this.repository.repositoryUri,
    });
    new cdk.CfnOutput(this, "ApiFunctionName", {
      value: this.apiFunction.functionName,
    });
    new cdk.CfnOutput(this, "ChatFunctionName", {
      value: this.chatFunction.functionName,
    });
    new cdk.CfnOutput(this, "IngestFunctionName", {
      value: this.ingestFunction.functionName,
    });
  }
}
