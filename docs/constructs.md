# Construct Catalogue

Custom constructs live in [`constructs/`](../constructs/). This document describes each one, its key design decisions, and the caveats worth knowing before modifying it.

## Table of Contents

- [Cluster](#cluster)
- [LoadBalancer](#loadbalancer)
- [PostgresDB](#postgresdb)
- [GraaspS3Bucket](#graasps3bucket)
- [CloudFront helpers](#cloudfront-helpers)
- [Security group helpers](#security-group-helpers)
- [TaskRole](#taskrole)
- [GateKeeper](#gatekeeper)
- [Ec2](#ec2)
- [BaremetalService](#baremetalservice)
- [DNS helper](#dns-helper)

---

## Cluster

**File:** [`constructs/cluster.ts`](../constructs/cluster.ts)

Wraps an ECS cluster and provides two methods for adding workloads to it.

### What it provisions

On construction:

- `EcsCluster`
- `ServiceDiscoveryHttpNamespace` — a single HTTP namespace named `graasp` that enables Service Connect DNS resolution between containers (e.g. `graasp-redis:6379`, `graasp-meilisearch:7700`)
- A shared **execution IAM role** with ECR pull and CloudWatch Logs permissions — all task definitions in the cluster share this role

### `addService()`

Adds a long-running ECS Fargate service. Creates:

- A `CloudwatchLogGroup` per container (30-day retention)
- An `EcsTaskDefinition`
- An `EcsService` with `desiredCount` set to 0 if `isActive = false`
- Optionally: an `LbTargetGroup` + `LbListenerRule` if `loadBalancerConfig` is provided
- Optionally: `AppautoscalingTarget` + `AppautoscalingPolicy` if `appAutoscalingConfig` is provided

Returns `{ task, service, targetGroup }` — callers may need `targetGroup.arn` to attach additional listener rules (see the API path-prefix redirect rule in `main.ts`).

### `addOneOffTask()`

Adds a one-shot migration-style task. Creates:

- A `CloudwatchLogGroup` (7-day retention, shorter than services)
- An `EcsTaskDefinition`
- A `DataAwsEcsTaskExecution` **only when `isActive = true`** — this triggers Terraform to launch the task during `apply`

Because `DataAwsEcsTaskExecution` is a data source, Terraform re-runs the task on every `apply` when `isActive = true`. Do not set `isActive = true` for the migrate task in normal `running` or `restricted` states.

### `createContainerDefinitions()`

A standalone factory function (not a method) that builds the JSON structure expected by `EcsTaskDefinition.containerDefinitions`. It wires up CloudWatch log configuration automatically using the container name and deploy region.

Pass `disableVersionConsistency: true` for services that deploy independently from the task definition update — this sets `versionConsistency: "disabled"` on the container, which allows ECS to keep running existing containers at the old image version while new ones launch with the updated version.

---

## LoadBalancer

**File:** [`constructs/load_balancer.ts`](../constructs/load_balancer.ts)

Creates an internet-facing Application Load Balancer with HTTPS termination.

### What it provisions

- A `SecurityGroup` with inbound rules for 80/443 (IPv4 and IPv6) and unrestricted egress
- An `Lb` (ALB) across all public subnets with cross-zone load balancing enabled
- An HTTP listener (port 80) that unconditionally redirects to HTTPS
- An HTTPS listener (port 443) whose **default action** is a temporary redirect to `maintenance.*.graasp.org` — any request that does not match a rule ends up there

### `setupRedirections()`

Adds listener rules that permanently redirect legacy subdomains to their new paths on the apex domain (or `api.*`). These redirects can likely never be removed because they may be bookmarked by users. Called once during `GraaspStack` construction.

### Security group caveat

The ALB security group has `createBeforeDestroy: true`. The Terraform AWS provider requires this to avoid a replacement deadlock: if you modify the security group in a way that forces a recreate, Terraform must create the new one before destroying the old one, otherwise all downstream security group ingress references become invalid. **Never add inline `ingress`/`egress` blocks** to this security group — always use separate `VpcSecurityGroupIngressRule` / `VpcSecurityGroupEgressRule` resources (see the note in [security_group.ts](../constructs/security_group.ts)).

### ACM certificate

The constructor takes the **regional** ACM certificate (same region as the ALB). A separate `us-east-1` certificate is used by CloudFront. Both certificates must exist in AWS before deploying — they are looked up via `DataAwsAcmCertificate`, not created by Terraform.

---

## PostgresDB

**File:** [`constructs/postgres.ts`](../constructs/postgres.ts)

Wraps `terraform-aws-modules/rds/aws` to provision a PostgreSQL 16 instance with sensible defaults.

### What it provisions

- A security group that allows ingress on port 5432 from each `allowedSecurityGroup` source
- An optional additional ingress rule for the GateKeeper security group
- An `Rds` module instance (the primary)
- Optionally, a second `Rds` module instance as a read replica (when `addReplica = true`)

### Key defaults

| Setting                      | Value          | Rationale                                                               |
| ---------------------------- | -------------- | ----------------------------------------------------------------------- |
| `instanceClass`              | `db.t4g.micro` | Cost-optimised Graviton instance; overridable via `configOverride`      |
| `engineVersion`              | `16.11`        | Pinned; `autoMinorVersionUpgrade: false` to avoid surprise upgrades     |
| `storageType`                | `gp3`          | Better baseline IOPS than `gp2` at the same cost                        |
| `maxAllocatedStorage`        | 1000 GB        | Autoscaling storage cap                                                 |
| `deletionProtection`         | `true`         | Prevents accidental `destroy` from dropping the database                |
| `publiclyAccessible`         | `false`        | Never expose the DB to the internet                                     |
| `manageMasterUserPassword`   | `false`        | Password is passed as a `TerraformVariable` and injected at plan time   |
| `rds.force_ssl`              | `0`            | SSL is not enforced at the DB level; connections from ECS use plaintext |
| `performanceInsightsEnabled` | `true`         | 7-day retention at no extra cost for `t` instance classes               |

### Stopped-state caveat

The `_isActive` parameter is currently a no-op. The `RdsInstanceState` resource that would stop/start the instance is commented out due to [hashicorp/terraform-provider-aws#40785](https://github.com/hashicorp/terraform-provider-aws/issues/40785). The DB remains running in all infrastructure states, including `stopped`.

---

## GraaspS3Bucket

**File:** [`constructs/bucket.ts`](../constructs/bucket.ts)

Creates an S3 bucket with optional static website hosting, public access, and CORS configuration.

### Modes

**Private bucket** (`website: false`):

- `S3BucketPublicAccessBlock` with all four block settings enabled
- No public bucket policy

**Public website bucket** (`website: true`):

- `S3BucketWebsiteConfiguration` with `index.html` / `error.html`
- `S3BucketPublicAccessBlock` with all four block settings **disabled**
- `DataAwsIamPolicyDocument` + `S3BucketPolicy` granting `s3:GetObject` to `*`

### Bucket ownership

The `bucketOwnership` parameter sets `S3BucketOwnershipControls`. Default is `ObjectWriter`. Use `BucketOwnerEnforced` when ACLs should be disabled (e.g. the H5P bucket, which is always written to by the same account).

### CORS

Pass `customCors` rules to create an `S3BucketCorsConfiguration`. Leave it empty (`[]`) to skip CORS configuration. File-item buckets have complex CORS rules to allow `PUT` from `null` origin (browser direct upload) and `GET` from the assets subdomain.

---

## CloudFront helpers

**File:** [`constructs/cloudfront.ts`](../constructs/cloudfront.ts)

Two exported functions, not a class.

### `makeCloudfront()`

Creates a `CloudfrontDistribution` backed by an S3 website endpoint.

Key options:

- `isUsingWebsiteEndpoint` — when `true`, uses a `customOriginConfig` with `http-only` protocol. S3 website endpoints only speak HTTP; using S3 REST endpoints instead would require OAC/OAI setup.
- `functionAssociationArn` — if provided, attaches a CloudFront function on the `viewer-request` event. Used for maintenance gating.
- `exposeDNS` — if `true`, creates a Route 53 alias record pointing to the distribution. Pass `false` when you create the DNS entry separately or do not need it.
- `aliasToEnvApex` — points the distribution alias to the apex domain (`graasp.org`) instead of a subdomain.

Custom error responses rewrite 403/404 to `index.html` with status 200. This is required for SPAs using client-side routing — S3 returns 403 for keys that do not exist.

The `CACHING_OPTIMIZED_ID` constant is the well-known ID of the AWS-managed cache policy. It must not be changed to a custom policy without verifying cache behaviour for all distributions.

### `createMaintenanceFunction()`

Creates a `CloudfrontFunction` (JS 2.0 runtime) that inspects the `viewer-request` for a secret header. If the header is absent, it returns a 302 redirect to the maintenance subdomain.

When `headerSecret` is `undefined` (i.e. the infrastructure is in `running` state), the function returns a pass-through handler and `createMaintenanceFunction` returns `undefined` so it can be de-associated from distributions. Passing `undefined` to `functionAssociationArn` in `makeCloudfront` is how the association is removed.

---

## Security group helpers

**File:** [`constructs/security_group.ts`](../constructs/security_group.ts)

Three factory functions that create pre-wired security groups:

| Function                                        | Use case                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `securityGroupEgressOnly`                       | Service that initiates connections but accepts none (workers)         |
| `securityGroupOnlyAllowAnotherSecurityGroup`    | Service reachable from exactly one upstream SG (most ECS services)    |
| `securityGroupAllowMultipleOtherSecurityGroups` | Service reachable from multiple upstream SGs (meilisearch, redis, DB) |

All three attach an unrestricted egress rule via `allowAllEgressRule`. All use `createBeforeDestroy: true` on the `SecurityGroup` resource.

### Why separate `VpcSecurityGroupIngressRule` resources?

The Terraform AWS provider has a known limitation: combining inline `ingress`/`egress` blocks on a `SecurityGroup` with separate `VpcSecurityGroupIngressRule` resources targeting the same group causes conflicts and drift. This project uses **only** the separate resource approach everywhere.

---

## TaskRole

**File:** [`constructs/task_role.ts`](../constructs/task_role.ts)

A builder-pattern construct for composing ECS task IAM roles.

```typescript
const role = new TaskRole(this, 'admin')
  .allowECSExec()
  .allowS3Access(
    { arn: bucket.arn, name: 'files' },
    { read: true, write: true },
  )
  .allowSESAccess();
```

Each method appends an `IamRolePolicy` to the role and returns `this` for chaining. Available methods:

| Method                                 | Grants                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `allowECSExec()`                       | SSM messages for `ecs execute-command`                                             |
| `allowS3Access(bucket, {read, write})` | `s3:GetObject` and/or `s3:PutObject` on the bucket ARN + `s3:ListBucket` for reads |
| `allowSESAccess()`                     | `ses:SendEmail`, `ses:SendRawEmail`                                                |

Only the `admin` service uses a `TaskRole` today. The core/workers services access S3 via access key environment variables rather than an IAM task role — those could be migrated to task role access in the future.

---

## GateKeeper

**File:** [`constructs/gate_keeper.ts`](../constructs/gate_keeper.ts)

A thin wrapper around `Ec2` that configures a manually-started EC2 instance for direct database access.

The instance is launched **stopped** by default (`isActive: false`). Its `userData` script installs `postgresql15` on first boot.

Three `TerraformVariable` inputs are required:

- `GRAASP_DB_GATEKEEPER_KEY_NAME` — name of an existing EC2 key pair for SSH access
- `DB_GATEKEEPER_AMI_ID` — AMI ID (Amazon Linux recommended)
- `DB_GATEKEEPER_INSTANCE_TYPE` — instance type (e.g. `t3.micro`)

The GateKeeper's security group is passed to `PostgresDB` and to the `meilisearch` security group, allowing the operator to reach both the database and the search index directly.

**To use:** start the instance from the AWS console, SSH in, and run `psql` against the DB address. Stop the instance when done.

---

## Ec2

**File:** [`constructs/ec2.ts`](../constructs/ec2.ts)

Low-level EC2 instance construct used by both `GateKeeper` and `BaremetalService`.

Provisions:

- A `SecurityGroup` with SSH (port 22) open to `0.0.0.0/0` and unrestricted egress
- An `Instance` placed in the first public subnet of the VPC
- An `Ec2InstanceState` resource to control power state (`running` / `stopped`)

The instance's public IP address is ignored on subsequent applies (`ignoreChanges: ['associate_public_ip_address']`) because AWS may reassign it on stop/start and Terraform would otherwise try to modify the attribute.

`addSecurityGroupIngress()` lets callers add additional inbound rules after construction (used by `BaremetalService` to allow traffic from the ALB security group).

---

## BaremetalService

**File:** [`constructs/baremetal_service.ts`](../constructs/baremetal_service.ts)

Registers an EC2 instance as an ALB target group member. Used for the `collab` service (dev only) which runs on an ARM Graviton EC2 instance rather than ECS Fargate.

The `targetType` is `instance` (IP-based is not supported for non-VPC-mode EC2 targets when the instance has a public IP only). The ALB connects to the instance on the specified port; the instance's security group must allow ingress from the ALB security group.

The `isActive` flag drives the `Ec2InstanceState` — the instance is powered off when the service is inactive, and the ALB target group health checks will mark it unhealthy until it starts.

---

## DNS helper

**File:** [`constructs/dns.ts`](../constructs/dns.ts)

A thin wrapper around `Route53Record` that creates an alias A record.

```typescript
createDNSEntry(this, 'api', {
  zoneId: environment.hostedZoneId,
  domainName: subdomainForEnv('api', environment),
  alias: {
    dnsName: loadBalancer.dualstackDnsName,
    zoneId: loadBalancer.lb.zoneId,
  },
});
```

The `dualstackDnsName` getter on `LoadBalancer` prepends `dualstack.` to the ALB DNS name. This is required for alias records that should resolve over both IPv4 and IPv6.
