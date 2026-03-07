export interface AwsConfig {
  /** Whether AWS is configured (has credentials) */
  readonly enabled: boolean

  /** AWS region for all services */
  readonly region: string

  /** AWS credentials — undefined means use SDK default chain (IAM role, EC2/ECS/Lambda metadata) */
  readonly credentials: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  } | undefined

  /** DynamoDB configuration */
  readonly dynamodb: {
    readonly tableUserState: string
    readonly tableEngagement: string
  }

  /** S3 bucket configuration */
  readonly s3: {
    readonly trainingBucket: string
    readonly scoutBucket: string
  }

  /** Bedrock configuration */
  readonly bedrock: {
    readonly modelId: string
    readonly region: string
  }

  /** Lambda + EventBridge configuration */
  readonly lambda: {
    readonly proactiveArn: string
    readonly eventBridgeRuleArn: string
  }

  /** SNS configuration */
  readonly sns: {
    readonly squadTopicArn: string
    readonly notificationTopicArn: string
  }

  /** ElastiCache (Redis) configuration */
  readonly elasticache: {
    readonly endpoint: string
    readonly port: number
  }

  /** CloudWatch configuration */
  readonly cloudwatch: {
    readonly namespace: string
  }
}

// ─── Config Builder ───────────────────────────────────────────────────────────

function loadConfig(): AwsConfig {
  // Only construct explicit credentials when both keys are present.
  // When omitted (undefined), the AWS SDK resolves credentials via its default
  // provider chain: env vars → shared credentials file → EC2/ECS/Lambda
  // instance metadata (IMDSv2) → IAM role. This means the app works correctly
  // in both local dev (explicit keys) and production on AWS infra (IAM role).
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN
  const hasExplicitKeys = !!(accessKeyId && secretAccessKey)

  // enabled = true if we have explicit keys OR if explicitly opted-in for
  // IAM-role/metadata environments (ECS/Lambda). AWS_REGION alone is NOT
  // sufficient — a dev shell may export it without valid credentials.
  // Set AWS_ENABLED=true in ECS/Lambda task definitions to opt in.
  const enabled = hasExplicitKeys || process.env.AWS_ENABLED === 'true'

  const credentials = hasExplicitKeys
    ? { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, ...(sessionToken ? { sessionToken } : {}) }
    : undefined

  return {
    enabled,
    region: process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-south-1',
    credentials,

    dynamodb: {
      tableUserState: process.env.AWS_DYNAMODB_TABLE_USER_STATE ?? 'aria-user-state',
      tableEngagement: process.env.AWS_DYNAMODB_TABLE_ENGAGEMENT ?? 'aria-engagement-metrics',
    },

    s3: {
      trainingBucket: process.env.AWS_S3_TRAINING_BUCKET ?? 'aria-training-data',
      scoutBucket: process.env.AWS_S3_SCOUT_BUCKET ?? 'aria-scout-results',
    },

    bedrock: {
      modelId: process.env.AWS_BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0',
      region: process.env.AWS_BEDROCK_REGION ?? 'ap-south-1',
    },

    lambda: {
      proactiveArn: process.env.AWS_LAMBDA_PROACTIVE_ARN ?? '',
      eventBridgeRuleArn: process.env.AWS_EVENTBRIDGE_RULE_ARN ?? '',
    },

    sns: {
      squadTopicArn: process.env.AWS_SNS_SQUAD_TOPIC_ARN ?? '',
      notificationTopicArn: process.env.AWS_SNS_NOTIFICATION_TOPIC_ARN ?? '',
    },

    elasticache: {
      endpoint: process.env.AWS_ELASTICACHE_ENDPOINT ?? '',
      port: parseInt(process.env.AWS_ELASTICACHE_PORT ?? '6379', 10) || 6379,
    },

    cloudwatch: {
      namespace: process.env.AWS_CLOUDWATCH_NAMESPACE ?? 'Aria/ProactiveAgent',
    },
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let cached: AwsConfig | null = null

/**
 * Get the AWS configuration singleton.
 * Lazily loaded on first call, cached thereafter.
 */
export function getAwsConfig(): AwsConfig {
  if (!cached) {
    cached = loadConfig()
    if (cached.enabled) {
      console.log(`[AWS] Configured — region=${cached.region}`)
    } else {
      console.log('[AWS] Not configured — all services will use local fallbacks')
    }
  }
  return cached
}

/**
 * Check if a specific AWS service is configured and usable.
 */
export function isServiceEnabled(service: 'dynamodb' | 'bedrock' | 'lambda' | 'sns' | 'elasticache' | 'cloudwatch' | 's3'): boolean {
  const config = getAwsConfig()
  if (!config.enabled) return false

  switch (service) {
    case 'dynamodb':
      return !!(config.dynamodb.tableUserState || config.dynamodb.tableEngagement)
    case 'bedrock':
      return !!config.bedrock.modelId
    case 'lambda':
      return !!config.lambda.proactiveArn
    case 'sns':
      return !!(config.sns.squadTopicArn || config.sns.notificationTopicArn)
    case 'elasticache':
      return !!config.elasticache.endpoint
    case 'cloudwatch':
      return true // always available when AWS creds exist
    case 's3':
      return !!(config.s3.trainingBucket || config.s3.scoutBucket)
    default:
      return false
  }
}

// ─── Reset (testing only) ─────────────────────────────────────────────────────

/** @internal — for tests only */
export function _resetConfigCache(): void {
  cached = null
}
