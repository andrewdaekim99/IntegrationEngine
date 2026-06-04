# integr8 — AWS Deployment Runbook

A step-by-step guide for the Phase 8 one-shot AWS demo. The intent is **spin up
→ screenshots → tear down**, not run-forever. Per `PROJECT_DIRECTION.md` §5,
the MVP runs locally via `docker compose`; AWS exists to prove the production
path works.

If you haven't done the **Phase 8 prep checklist** in `ROADMAP.md`, do that
first — it covers AWS account, MFA, IAM user, AWS CLI config, and the billing
alert. Everything below assumes `aws sts get-caller-identity` works.

---

## Architecture

```
                 ┌──────────────┐
   Shopify ───►  │ Application  │ (HTTPS, public)
   webhook       │ Load Balancer│
                 └──────┬───────┘
                        │
                        ▼
                ┌───────────────┐
                │ ECS Fargate   │   apps/api task
                │ api service   │   (Fastify, port 3010)
                └───────┬───────┘
                        │
              ┌─────────┼──────────┐
              ▼         ▼          ▼
        ┌────────┐ ┌────────┐  ┌──────────┐
        │  RDS   │ │  SQS   │  │  Stripe  │ (external)
        │Postgres│ │ main + │  │ test mode│
        └────┬───┘ │  DLQ   │  └──────────┘
             │     └────┬───┘
             │          │
             │     ┌────▼─────────┐
             │     │ ECS Fargate  │
             └────►│ worker service│ — consumes SQS, hits Stripe
                   └───────────────┘
```

Not deployed: `apps/mock-erp` (a stub; in real production you'd hit a real
ERP), `apps/dashboard` (stays local, points at the AWS API URL).

---

## 0. Set the working variables

Everything below references these. Set them once in your shell.

```sh
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PROJECT=integr8

# Resource names (consistent prefix makes teardown grep-able)
export ECR_REPO_API=${PROJECT}-api
export ECR_REPO_WORKER=${PROJECT}-worker
export RDS_DB_ID=${PROJECT}-postgres
export SQS_MAIN_NAME=${PROJECT}-sync
export SQS_DLQ_NAME=${PROJECT}-sync-dlq
export ECS_CLUSTER=${PROJECT}-cluster
export ALB_NAME=${PROJECT}-alb
export LOG_GROUP=/ecs/${PROJECT}
```

Verify: `echo "$AWS_ACCOUNT_ID / $AWS_REGION"` should print your account id and region.

---

## 1. ECR repositories + push images

Create one repo per image (api + worker), build with `Dockerfile.prod`, push.

```sh
# Create repos
aws ecr create-repository --repository-name $ECR_REPO_API
aws ecr create-repository --repository-name $ECR_REPO_WORKER

# Auth Docker to ECR
aws ecr get-login-password \
  | docker login --username AWS --password-stdin \
      ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Build + push api
docker build -f Dockerfile.prod --build-arg APP_NAME=api \
  -t ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_API}:latest \
  --platform linux/amd64 .
docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_API}:latest

# Build + push worker
docker build -f Dockerfile.prod --build-arg APP_NAME=worker \
  -t ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_WORKER}:latest \
  --platform linux/amd64 .
docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_WORKER}:latest
```

> `--platform linux/amd64` matters on Apple Silicon — Fargate runs on x86 by
> default; an arm64 image would fail the task pull on most cluster configs.

---

## 2. SQS queues

```sh
# DLQ first; the main queue references it in its redrive policy.
aws sqs create-queue --queue-name $SQS_DLQ_NAME
export SQS_DLQ_URL=$(aws sqs get-queue-url --queue-name $SQS_DLQ_NAME --query QueueUrl --output text)
export SQS_DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url $SQS_DLQ_URL --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# Main queue with redrive to DLQ (SQS-side redrive isn't used by the app —
# the app DLQs explicitly — but having it set is good defense-in-depth.)
aws sqs create-queue --queue-name $SQS_MAIN_NAME \
  --attributes "RedrivePolicy={\"deadLetterTargetArn\":\"$SQS_DLQ_ARN\",\"maxReceiveCount\":\"10\"}"
export SQS_MAIN_URL=$(aws sqs get-queue-url --queue-name $SQS_MAIN_NAME --query QueueUrl --output text)
```

---

## 3. RDS Postgres

Free-tier `db.t3.micro`. Provisioning takes ~10–15 minutes.

```sh
aws rds create-db-instance \
  --db-instance-identifier $RDS_DB_ID \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username integr8 \
  --master-user-password <PICK_A_STRONG_PASSWORD> \
  --allocated-storage 20 \
  --no-multi-az \
  --publicly-accessible \
  --db-name integr8

# Wait for it to come up (returns when status == 'available')
aws rds wait db-instance-available --db-instance-identifier $RDS_DB_ID

# Grab the endpoint
export RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier $RDS_DB_ID \
  --query 'DBInstances[0].Endpoint.Address' --output text)
export DATABASE_URL="postgresql://integr8:<PASSWORD>@${RDS_ENDPOINT}:5432/integr8?schema=public"
```

> For a real deploy you'd use a private subnet + a bastion or
> Session Manager for psql access. `--publicly-accessible` is a demo
> shortcut; tighten security-group rules to your IP and tear down quickly.

**Run the Prisma migration against the new database** before the worker starts:

```sh
DATABASE_URL=$DATABASE_URL pnpm db:migrate deploy
```

---

## 4. CloudWatch log groups

```sh
aws logs create-log-group --log-group-name $LOG_GROUP/api
aws logs create-log-group --log-group-name $LOG_GROUP/worker
aws logs put-retention-policy --log-group-name $LOG_GROUP/api --retention-in-days 7
aws logs put-retention-policy --log-group-name $LOG_GROUP/worker --retention-in-days 7
```

---

## 5. IAM roles

ECS tasks need two roles:
- **Task execution role** — pulls images from ECR, writes to CloudWatch Logs.
- **Task role** — what the *application* uses to talk to AWS (SQS in our case).

```sh
# Task execution role
aws iam create-role --role-name ${PROJECT}-task-execution-role \
  --assume-role-policy-document file://infra/trust-policy-ecs-tasks.json
aws iam attach-role-policy --role-name ${PROJECT}-task-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Task role (for SQS access from the app)
aws iam create-role --role-name ${PROJECT}-task-role \
  --assume-role-policy-document file://infra/trust-policy-ecs-tasks.json
# Inline policy: allow SendMessage / ReceiveMessage / DeleteMessage on our queues
aws iam put-role-policy --role-name ${PROJECT}-task-role \
  --policy-name SqsAccess \
  --policy-document file://infra/iam-policy-sqs.json
```

Create the JSON files in `infra/` (templates at the end of this README).

---

## 6. ECS cluster + task definitions + services

```sh
aws ecs create-cluster --cluster-name $ECS_CLUSTER
```

**Task definitions** live in `infra/task-def-api.json` and
`infra/task-def-worker.json` — copy from the templates at the end and fill in
`ACCOUNT_ID`, image tags, env vars (`DATABASE_URL`, `REDIS_URL`, `QUEUE_DRIVER=sqs`,
`AWS_REGION`, `SQS_QUEUE_URL`, `SQS_DLQ_URL`, `ANTHROPIC_API_KEY`,
`STRIPE_TEST_KEY`, `SHOPIFY_WEBHOOK_SECRET`, `MOCK_ERP_URL=<skip or stub>`).

```sh
aws ecs register-task-definition --cli-input-json file://infra/task-def-api.json
aws ecs register-task-definition --cli-input-json file://infra/task-def-worker.json
```

**Services** — these create the long-running tasks. The api service needs the
ALB target group ARN from §7; create §7 first, then come back here.

```sh
aws ecs create-service --cluster $ECS_CLUSTER \
  --service-name ${PROJECT}-api \
  --task-definition ${PROJECT}-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_IDS>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TARGET_GROUP_ARN,containerName=api,containerPort=3010"

aws ecs create-service --cluster $ECS_CLUSTER \
  --service-name ${PROJECT}-worker \
  --task-definition ${PROJECT}-worker \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_IDS>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}"
```

---

## 7. ALB + target group + listener

```sh
# Create target group pointing at the api task on port 3010
aws elbv2 create-target-group \
  --name ${PROJECT}-api-tg \
  --protocol HTTP --port 3010 \
  --vpc-id <DEFAULT_VPC_ID> \
  --target-type ip \
  --health-check-path /healthz \
  --health-check-interval-seconds 30
export TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups \
  --names ${PROJECT}-api-tg --query 'TargetGroups[0].TargetGroupArn' --output text)

# Create ALB in the default VPC
aws elbv2 create-load-balancer \
  --name $ALB_NAME \
  --subnets <PUBLIC_SUBNET_IDS> \
  --security-groups <ALB_SG_ID> \
  --type application
export ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names $ALB_NAME --query 'LoadBalancers[0].LoadBalancerArn' --output text)
export ALB_DNS=$(aws elbv2 describe-load-balancers \
  --names $ALB_NAME --query 'LoadBalancers[0].DNSName' --output text)

# Listener on :80 forwarding to the target group
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TARGET_GROUP_ARN
```

The webhook URL Shopify points at becomes `http://$ALB_DNS/webhooks/shopify/orders`.
For HTTPS, add an ACM certificate + a 443 listener.

---

## 8. Smoke test

```sh
# Health check via ALB
curl http://$ALB_DNS/healthz
# → {"ok":true,"service":"api"}

# Tail logs
aws logs tail $LOG_GROUP/api --follow
# (in another shell)
aws logs tail $LOG_GROUP/worker --follow

# Send a webhook
SECRET=$SHOPIFY_WEBHOOK_SECRET API_URL=http://$ALB_DNS pnpm dev:send-test-webhook -- --new
# Should see: api logs "shopify webhook ingested + enqueued"
#             worker logs "delivering" then "delivery succeeded" for mock-erp + stripe
```

Stripe test-mode dashboard → Payments — verify the PaymentIntent appeared.

**Screenshot list for the README:**
- ECS console → cluster → services running
- CloudWatch logs of a real webhook (api + worker, side by side)
- RDS Query Editor showing the new IngestedEvent + SyncRun rows
- SQS metrics tab showing the spike
- Stripe test-mode dashboard with the PaymentIntent metadata

---

## 9. Teardown

**Do this the same day** — Fargate + ALB bill by the hour.

```sh
# 1. Scale services to 0 (stop running tasks)
aws ecs update-service --cluster $ECS_CLUSTER --service ${PROJECT}-api --desired-count 0
aws ecs update-service --cluster $ECS_CLUSTER --service ${PROJECT}-worker --desired-count 0

# 2. Delete services + cluster
aws ecs delete-service --cluster $ECS_CLUSTER --service ${PROJECT}-api --force
aws ecs delete-service --cluster $ECS_CLUSTER --service ${PROJECT}-worker --force
aws ecs delete-cluster --cluster $ECS_CLUSTER

# 3. Delete ALB + listener + target group
aws elbv2 delete-listener --listener-arn <LISTENER_ARN>
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $TARGET_GROUP_ARN

# 4. Delete RDS (snapshot first if you want to keep the data)
aws rds delete-db-instance --db-instance-identifier $RDS_DB_ID \
  --skip-final-snapshot --delete-automated-backups

# 5. Delete SQS queues
aws sqs delete-queue --queue-url $SQS_MAIN_URL
aws sqs delete-queue --queue-url $SQS_DLQ_URL

# 6. Delete CloudWatch log groups
aws logs delete-log-group --log-group-name $LOG_GROUP/api
aws logs delete-log-group --log-group-name $LOG_GROUP/worker

# 7. Delete ECR images + repos
aws ecr batch-delete-image --repository-name $ECR_REPO_API \
  --image-ids imageTag=latest
aws ecr batch-delete-image --repository-name $ECR_REPO_WORKER \
  --image-ids imageTag=latest
aws ecr delete-repository --repository-name $ECR_REPO_API
aws ecr delete-repository --repository-name $ECR_REPO_WORKER

# 8. Delete IAM roles
aws iam detach-role-policy --role-name ${PROJECT}-task-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name ${PROJECT}-task-execution-role
aws iam delete-role-policy --role-name ${PROJECT}-task-role --policy-name SqsAccess
aws iam delete-role --role-name ${PROJECT}-task-role
```

**24h verification:** AWS Cost Explorer → Daily costs → confirm no ongoing
charges. Delete the IAM user + access keys (and optionally close the AWS
account if you created a fresh one).

---

## Appendix: JSON template files

These live in `infra/` and are filled in during deploy.

### `infra/trust-policy-ecs-tasks.json`

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

### `infra/iam-policy-sqs.json`

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl"
    ],
    "Resource": [
      "arn:aws:sqs:*:*:integr8-sync",
      "arn:aws:sqs:*:*:integr8-sync-dlq"
    ]
  }]
}
```

### `infra/task-def-api.json` (template)

```json
{
  "family": "integr8-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/integr8-task-execution-role",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/integr8-task-role",
  "containerDefinitions": [{
    "name": "api",
    "image": "ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/integr8-api:latest",
    "essential": true,
    "portMappings": [{ "containerPort": 3010, "protocol": "tcp" }],
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "QUEUE_DRIVER", "value": "sqs" },
      { "name": "API_PORT", "value": "3010" },
      { "name": "AWS_REGION", "value": "REGION" },
      { "name": "DATABASE_URL", "value": "REPLACE" },
      { "name": "REDIS_URL", "value": "unused-in-sqs-mode" },
      { "name": "SQS_QUEUE_URL", "value": "REPLACE" },
      { "name": "SQS_DLQ_URL", "value": "REPLACE" },
      { "name": "SHOPIFY_WEBHOOK_SECRET", "value": "REPLACE" },
      { "name": "ANTHROPIC_API_KEY", "value": "REPLACE" },
      { "name": "ANTHROPIC_MODEL", "value": "claude-sonnet-4-6" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/integr8/api",
        "awslogs-region": "REGION",
        "awslogs-stream-prefix": "api"
      }
    }
  }]
}
```

### `infra/task-def-worker.json` (template)

```json
{
  "family": "integr8-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/integr8-task-execution-role",
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/integr8-task-role",
  "containerDefinitions": [{
    "name": "worker",
    "image": "ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/integr8-worker:latest",
    "essential": true,
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "QUEUE_DRIVER", "value": "sqs" },
      { "name": "AWS_REGION", "value": "REGION" },
      { "name": "DATABASE_URL", "value": "REPLACE" },
      { "name": "REDIS_URL", "value": "unused-in-sqs-mode" },
      { "name": "SQS_QUEUE_URL", "value": "REPLACE" },
      { "name": "SQS_DLQ_URL", "value": "REPLACE" },
      { "name": "MOCK_ERP_URL", "value": "skipped-in-aws-demo" },
      { "name": "STRIPE_TEST_KEY", "value": "REPLACE" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/integr8/worker",
        "awslogs-region": "REGION",
        "awslogs-stream-prefix": "worker"
      }
    }
  }]
}
```

---

## Notes & caveats

- **mock-erp isn't deployed.** The worker would need a real ERP endpoint or to
  skip the mock-erp destination. Two options: (1) remove mock-erp from the
  `destinations` array in `apps/worker/src/index.ts` for the cloud build, or
  (2) point `MOCK_ERP_URL` at a localhost listener via an SSH tunnel just for
  the demo. The Stripe destination is the more impressive one to demo anyway.
- **The dashboard stays local.** Run `pnpm --filter @integr8/dashboard dev`
  and set `INTERNAL_API_URL=http://$ALB_DNS` in your `.env`.
- **Secrets are env vars in the task def.** For real production use Secrets
  Manager or Parameter Store and reference `secrets[]` instead of
  `environment[]` in the container definition.
- **No HTTPS on the ALB.** Add ACM cert + 443 listener if Shopify rejects the
  http:// webhook URL (it does in some configurations).
