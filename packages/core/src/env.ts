import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  QUEUE_DRIVER: z.enum(['bullmq', 'sqs']).default('bullmq'),

  API_PORT: z.coerce.number().int().positive().default(3010),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  MOCK_ERP_PORT: z.coerce.number().int().positive().default(3002),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3003),

  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  STRIPE_TEST_KEY: z.string().optional(),

  AWS_REGION: z.string().optional(),
  SQS_QUEUE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(`Invalid environment variables:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}
