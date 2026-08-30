# Infrastructure Architecture

This document describes the overall design of the Graasp AWS infrastructure as defined in this CDKTF repository.

## Table of Contents

- [High-level overview](#high-level-overview)
- [Environments and AWS accounts](#environments-and-aws-accounts)
- [Terraform state](#terraform-state)
- [Network topology](#network-topology)
- [Request routing](#request-routing)
- [ECS services](#ecs-services)
- [Databases](#databases)
- [Static assets and CDN](#static-assets-and-cdn)
- [Security model](#security-model)
- [Infrastructure state machine](#infrastructure-state-machine)
- [IAM and cross-account access](#iam-and-cross-account-access)
- [ECR repositories](#ecr-repositories)

---

## High-level overview

The repository contains a single CDKTF `App` that synthesises two independent Terraform stacks. There is the dev and prod environment, each stemming from one shared `GraaspStack` class ([main.ts](../main.ts)):

```
GraaspStack("graasp-dev")   → AWS account 299720865162  (eu-central-1, Frankfurt)
GraaspStack("graasp-prod")  → AWS account 592217263685  (eu-central-2, Zurich)
```

Each stack is self-contained: it provisions its own VPC, load balancer, ECS cluster, RDS instances, S3 buckets, CloudFront distributions, DNS records, and all supporting IAM/security-group resources.

Per-environment differences (CPU/memory quotas, DB backup retention, replication) are captured in [config.ts](../config.ts). Everything else is structurally identical between environments.

---

## Environments and AWS accounts

| Stack         | AWS account  | Region                   | Root domain    |
| ------------- | ------------ | ------------------------ | -------------- |
| `graasp-dev`  | 299720865162 | eu-central-1 (Frankfurt) | dev.graasp.org |
| `graasp-prod` | 592217263685 | eu-central-2 (Zurich)    | graasp.org     |

The `dev` environment uses `*.dev.graasp.org` subdomains; production uses `*.graasp.org` (and the apex `graasp.org`).

A second AWS provider aliased `us_east` is configured in every stack solely to look up ACM certificates for CloudFront, which requires them to be in `us-east-1` regardless of the stack's primary region.

---

## Terraform state

State for both stacks is stored in a single S3 bucket (`graasp-terraform-state`) in **eu-central-2** (Zurich), under separate keys:

```
graasp-terraform-state/graasp-dev
graasp-terraform-state/graasp-prod
```

The bucket must be created manually before any `apply`. See [README.md](../README.md) for the required bucket policy.

---

## Network topology

Each stack creates a VPC using `terraform-aws-modules/vpc/aws`:

- CIDR: `172.32.0.0/16`
- Three **public** subnets across three availability zones (`a`, `b`, `c` of the stack's region)
- No private subnets

All ECS Fargate tasks run in public subnets with public IP addresses. Network isolation is enforced entirely through security groups (see [Security model](#security-model)).

```
VPC 172.32.0.0/16
├── subnet 172.32.1.0/24  (AZ a)
├── subnet 172.32.2.0/24  (AZ b)
└── subnet 172.32.3.0/24  (AZ c)
```

---

## Request routing

### DNS

All DNS is managed in Route 53 hosted zones:

| Environment | Hosted zone ID        |
| ----------- | --------------------- |
| dev         | Z09041603R2YNMQV7FSY5 |
| prod        | Z02416581F69HLSFNMD78 |

Records are created as **alias A records** pointing either to the ALB or to a CloudFront distribution.

### Application Load Balancer

A single internet-facing ALB handles all dynamic traffic. It has two listeners:

- **Port 80** — redirects unconditionally to HTTPS 443.
- **Port 443** — forwards to service target groups based on host-header listener rules; the **default action** redirects unmatched requests to the maintenance CloudFront distribution.

Listener rule priorities (lower = higher priority):

| Priority | Match                              | Action                                      |
| -------- | ---------------------------------- | ------------------------------------------- |
| 1        | `api.*.graasp.org` + path `/api/*` | Forward → core (backend)                    |
| 2        | `api.*.graasp.org` (all paths)     | Forward → core, rewriting path to `/api/$1` |
| 4        | `etherpad.*.graasp.org`            | Forward → etherpad                          |
| 5        | `umami.*.graasp.org`               | Forward → umami                             |
| 7        | `graasp.org` + path `/api/*`       | Forward → core (single-origin support)      |
| 8        | `graasp.org`                       | Forward → admin                             |
| 9        | `collab.*.graasp.org` (dev only)   | Forward → collab EC2                        |
| 30       | `library.*.graasp.org`             | Forward → graasp-library                    |
| 50–56    | Legacy subdomains                  | Permanent redirects to consolidated paths   |

**Legacy subdomain redirects** (priority 50–56) consolidate previously independent SPAs into single-origin paths:

| Old subdomain   | Redirects to                      |
| --------------- | --------------------------------- |
| `go.*`          | `api.*/items/short-links/#{path}` |
| `account.*`     | `graasp.org/account/#{path}`      |
| `auth.*`        | `graasp.org/auth/#{path}`         |
| `player.*`      | `graasp.org/player/#{path}`       |
| `builder.*`     | `graasp.org/builder/#{path}`      |
| `analytics.*`   | `graasp.org/analytics/#{path}`    |
| `association.*` | `graasp.org/about-us`             |

### CloudFront

Static content is served through CloudFront distributions backed by S3 website endpoints:

| Distribution  | Subdomain                  | Notes                                       |
| ------------- | -------------------------- | ------------------------------------------- |
| `maintenance` | `maintenance.*.graasp.org` | Shown to users during maintenance           |
| `h5p`         | `h5p.*.graasp.org`         | H5P content player                          |
| `apps`        | `apps.*.graasp.org`        | Published apps                              |
| `assets`      | `assets.*.graasp.org`      | Static assets; maintenance function applied |

CloudFront uses the `CACHING_OPTIMIZED` managed cache policy. 403/404 responses are rewritten to `index.html` with a 200, enabling client-side routing in SPAs.

---

## ECS services

All services run on ECS Fargate. They share a single ECS cluster and communicate via **ECS Service Connect** on an HTTP namespace named `graasp`. Services that need to be reachable by other services within the cluster are registered under a stable DNS name in this namespace.

### Service inventory

| Service                   | Docker image                   | Internal hostname         | Port | LB exposed        | Autoscaling |
| ------------------------- | ------------------------------ | ------------------------- | ---- | ----------------- | ----------- |
| `graasp` (core + nudenet) | ECR `graasp`                   | —                         | 3111 | Yes               | CPU 70%     |
| `workers`                 | ECR `graasp`                   | —                         | —    | No                | CPU 70%     |
| `admin`                   | ECR `graasp/admin`             | —                         | 4000 | Yes (apex domain) | No          |
| `graasp-library`          | ECR `graasp/explore`           | —                         | 3000 | Yes               | Memory 80%  |
| `etherpad`                | ECR `graasp/etherpad`          | —                         | 9001 | Yes               | No          |
| `umami`                   | `ghcr.io/umami-software/umami` | `umami:3000`              | 3000 | Yes               | No          |
| `meilisearch`             | `getmeili/meilisearch:v1.8`    | `graasp-meilisearch:7700` | 7700 | No                | No          |
| `iframely`                | `graasp/iframely`              | `graasp-iframely:8061`    | 8061 | No                | No          |
| `redis`                   | `redis:7-alpine`               | `graasp-redis:6379`       | 6379 | No                | No          |
| `migrate` (one-off)       | ECR `graasp`                   | —                         | —    | No                | —           |
| `collab` (dev only)       | EC2 bare-metal                 | —                         | 3000 | Yes               | No          |

The **core** task definition bundles two containers: the main backend (`core`) and a `nudenet` content-moderation sidecar that the backend calls at `http://localhost:8080/infer`.

The **migrate** task uses `addOneOffTask`, which runs an `aws_ecs_task_execution` data source at plan time — Terraform triggers the task during `apply` rather than keeping a long-running service.

### CPU architecture

Most services are built for `ARM64` (Graviton). Third-party images (`etherpad`, `meilisearch`, `redis`, `umami`, `iframely`) default to `X86_64`.

### Autoscaling

Services with autoscaling configured scale between their `desiredCount` and 8 replicas. Scaling policy type is `TargetTrackingScaling`.

---

## Databases

### Main Graasp DB

- Engine: PostgreSQL 16.11
- Module: `terraform-aws-modules/rds/aws` v6.13.1
- Instance class: `db.t4g.micro` (dev), `db.t4g.small` (prod — reserved instance)
- Storage: `gp3`, 20 GB allocated, up to 1 TB autoscaling
- Backups: 1-day retention (dev), 7-day retention (prod)
- Replication: disabled in both environments (flag exists to enable it)
- Multi-AZ: disabled
- Deletion protection: enabled
- Performance Insights: enabled, 7-day retention
- Enhanced monitoring: 60-second interval
- SSL: not enforced (`rds.force_ssl = 0`)
- Maintenance window: Saturday 00:08–00:38 UTC
- Backup window: 21:30–22:00 UTC

The main DB hosts three logical databases: `graasp` (backend), `etherpad`, and `umami`. All share the same RDS instance.

### GateKeeper EC2 instance

A stopped EC2 instance (`db.t3.micro` equivalent) is provisioned alongside the database. Its security group is whitelisted in the DB security group. When a developer needs direct database access (e.g. for manual migrations), they start this instance, SSH in, and use the pre-installed `psql` client. It is stopped by default to save cost.

---

## Static assets and CDN

Three S3 buckets store static content:

| Bucket             | Public | Website hosting | Purpose                                                 |
| ------------------ | ------ | --------------- | ------------------------------------------------------- |
| `{id}-file-items`  | No     | No              | User-uploaded files (private, accessed via signed URLs) |
| `{id}-h5p`         | Yes    | Yes             | H5P content packages                                    |
| `{id}-maintenance` | Yes    | Yes             | Maintenance page                                        |
| `{id}-apps`        | Yes    | Yes             | Published Graasp apps                                   |
| `{id}-assets`      | Yes    | Yes             | Static assets (images, fonts, etc.)                     |

`{id}` is the stack name, e.g. `graasp-dev`.

Public buckets are fronted by CloudFront. The `file-items` bucket is private; the backend accesses it directly using dedicated IAM credentials (`S3_ACCESS_KEY_ID` / `S3_ACCESS_SECRET_KEY_ID`).

---

## Security model

No private subnets are used. Instead, network access is controlled exclusively through security groups using **security group referencing** (no IP-CIDR rules between internal services).

### Security group topology

```
Internet
  │  80/443
  ▼
LoadBalancer SG  ──────────────────────────────────────────┐
  │                                                         │
  │ 3111           │ 3000       │ 9001    │ 4000   │ 3000   │ UMAMI_PORT
  ▼                ▼            ▼         ▼        ▼        ▼
Backend SG     Library SG   Etherpad SG  Admin SG  Umami SG
  │
  ├─ 7700 ──► Meilisearch SG  ◄── Workers SG
  ├─ 8061 ──► Iframely SG
  ├─ 6379 ──► Redis SG  ◄──────── Workers SG
  │
  └─ 5432 ──► DB SG  ◄── Workers SG, Umami SG, Etherpad SG, Admin SG,
                           Migrate SG, GateKeeper SG
```

Workers have **egress-only** security group — they initiate outbound connections but accept none.

The ALB security group uses `createBeforeDestroy` lifecycle to prevent dependency cycles when it needs replacement, since almost every other resource references it.

### Maintenance mode

When the infrastructure state is `restricted` or `db-only`, a secret HTTP header is required for access. The mechanism works at two layers:

1. **ALB listener rules** — each forward rule includes an `httpHeader` condition matching the maintenance header. Requests without it do not match any forwarding rule and fall through to the default action (redirect to maintenance page).
2. **CloudFront function** — a CloudFront JS function associated with the `viewer-request` event on static distributions (e.g. `assets`) enforces the same header check and redirects non-matching requests to the maintenance page.

The header name and secret value are injected at synth time via `MAINTENANCE_HEADER_NAME` and `MAINTENANCE_HEADER_SECRET` environment variables.

---

## Infrastructure state machine

The `INFRA_STATE` environment variable (set before running `cdktf deploy`) selects one of four states. The active state determines which ECS services are running (desired count > 0).

```
                 ┌──────────┐
             ┌──►│  running │◄──┐
             │   └──────────┘   │
             │                  │
    ┌────────────┐       ┌────────────┐
    │ restricted │       │  db-only   │
    └────────────┘       └────────────┘
             │                  │
             └──► ┌─────────┐ ◄─┘
                  │ stopped │
                  └─────────┘
```

| State        | Database | graasp/workers/library | admin/umami | migrate | Maintenance header required |
| ------------ | -------- | ---------------------- | ----------- | ------- | --------------------------- |
| `running`    | ✅       | ✅                     | ✅          | ❌      | ❌                          |
| `restricted` | ✅       | ✅                     | ✅          | ❌      | ✅                          |
| `db-only`    | ✅       | ❌                     | ✅          | ✅      | ✅                          |
| `stopped`    | ❌       | ❌                     | ❌          | ❌      | ✅                          |

`stopped` is used to reduce costs during nights/weekends on low-usage environments. `db-only` is used before breaking migrations to quiesce the application layer while keeping the database reachable.

> **Note:** The DB cannot currently be stopped automatically via Terraform due to a provider bug ([hashicorp/terraform-provider-aws#40785](https://github.com/hashicorp/terraform-provider-aws/issues/40785)). The `_isActive` parameter in `PostgresDB` is accepted but has no effect.

---

## IAM and cross-account access

### Terraform execution

The CI pipeline authenticates as a dedicated `terraform` IAM **user** in the root AWS account. This user has only `sts:AssumeRole` permission. The stacks then assume environment-specific **roles**:

| Environment | Role ARN                                   |
| ----------- | ------------------------------------------ |
| dev         | `arn:aws:iam::299720865162:role/terraform` |
| prod        | `arn:aws:iam::592217263685:role/terraform` |

These roles have administrator permissions within their respective accounts.

### ECS task roles

Two IAM roles are created per service:

- **Execution role** (shared across all services in a cluster) — allows ECS to pull images from ECR and write logs to CloudWatch.
- **Task role** (per-service, optional) — grants the running container access to AWS services. Currently only the `admin` service has a custom task role, which allows: ECS Exec (SSM), read/write to `file-items` and `h5p` S3 buckets, and SES for sending emails.

---

## ECR repositories

Most ECR repositories are **not** managed by Terraform — they are looked up via `DataAwsEcrRepository`. This is intentional: it prevents `cdktf destroy` from deleting image repositories.

The exception is `graasp/admin`, which is managed by Terraform and has a lifecycle policy:

- Untagged images expire after 1 day.
- At most 2 tagged images are retained.
