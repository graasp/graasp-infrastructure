# Why infrastructure as code?

- **Documentation**: Most of the AWS resources are defined in code, hence we know what exists without exploring the whole AWS console.
- **Consistency**: The setup is similar between the different environment, reducing configuration drift.
- **Batch changes**: Want to move the whole infrastructure to a new region? Terraform will recreate all the resources with the same config, preventing us from forgetting an option somewhere in the console. We only need to migrate the stateful data (Database, S3...). Want to change the config generally used for S3 buckets? Change it in one place, all buckets are updated.

# Pre-requisites to run terraform

## Locally

- install [terraform](https://developer.hashicorp.com/terraform/tutorials/aws-get-started/install-cli)

## Infrastructure

- a `terraform` user has been created with only the permission to assume roles (sts:AssumeRole)
- a `terraform` role with administrator permissions is created in each subaccount managed by the organization (dev, staging, prod). These roles trust the terraform user to impersonate them.
- A S3 bucket in production to store the Terraform state with ideally:
  - Bucket versionning enabled
  - Encryption at rest enabled
  - Access only allowed to the `terraform` user:

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "[Your Terraform user ARN]"
            },
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::graasp-terraform-state"
        },
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "[Your Terraform user ARN]"
            },
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "arn:aws:s3:::graasp-terraform-state/*"
        }
    ]
}
```

- ECR repositories must exist in the environment: `graasp`, `graasp/explore`, `graasp/etherpad`
- A valid ACM certificate for the domain of the environment (`dev.graasp.org`...), one in the region of the deployment and one in `us-east-1` (for Cloudfront)
- Currently, Route53 records (for accessings apps and for certificates) must be managed manually.
  - When the cloudfront certificate is created for the first time, you must go to the certificate page in the console and use the "Create certificate in Route53" button.
  - TODO: To manage route53 with Terraform, create a hosted zone in each env, then create one NS record in the prod account for the corresponding env. This will allow the env to manage the records for its own domain.

# Install

```bash
# install dependencies
yarn
# Generate CDK Constructs for Terraform providers and modules.
yarn get
```

You need to export some variables before running cdktf:

```bash
export AWS_ACCESS_KEY_ID="yourkey"
export AWS_SECRET_ACCESS_KEY="yoursecret"

# use the passwords that will be really used!
export TF_VAR_GRAASP_DB_PASSWORD="password"
export TF_VAR_ETHERPAD_DB_PASSWORD="password"
export TF_VAR_MEILISEARCH_MASTER_KEY="masterkey"
export TF_VAR_GRAASP_DB_GATEKEEPER_KEY_NAME="gatekeeper-keyname"
```

You can run `export -p` to show the active variables.

<div id="run"></div>

# Run

```bash
 # generates stacks for the defined environments
cdktf synth
 # show diff with currently deployed on aws
cdktf diff <stack-name>
```

You might want to escape some characters (`!`, `.`).
At this point shouldn't have any difference with the current deployed stack.

```
Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

# Migrate existing data

Even if we can easily create a whole infrastructure with this repository, this infrastructure does not handle deployment. Deployment is handled by GitHub Actions, mostly to update task definitions and fill S3 buckets. Currently, there are a lot of secrets set in GitHub Actions that must be updated for the deployments to work, which takes more time that creating the infrastructure itself. Also, RDS database migration is not straightforward.

These are instructions for creating a new env and updating the deployment process to point to the new environment.

For the first infrastructure creation, I suggest working locally by creating a new keypair for the `terraform` **user** in the production account. Then you can use the cdktf CLI to deploy the infrastructure and check for any errors.

**You need to export some variables before running cdktf (see the [Run](#run) section)**

Then you can run cdktf for the environment you want i.e.

```bash
yarn run cdktf plan 'graasp-staging' # this command won't change anything
```

Once everything is created properly, you can let the CI handle the infrastructure changes.

In order to create a new environment and migrate the data, follow these instructions:

- Down the production to prevent data changes
- Remove the alternate domain names from all the old cloudfront distributions (or temporarily modify the infra code to use different alternate names)
  - The alternate domains must be available because the infrastructure will use them for the new cloudfront distribution.
- Create the new environment (You then have 2 environments in parallel)
- Update the task definition file for your environment in `.aws` in graasp and library (update family name, graasp container name, executionRoleArn and awslogs-region)
- Update the CI/CD secrets for deployments to point to new S3 buckets, ECS cluster/service...
  - Graasp core
    - ECR*REPOSITORY*{ENV} (if needed)
    - CONTAINER*NAME_GRAASP*{ENV}
    - AWS*REGION*{ENV}
    - DB_HOST
    - DB_PASSWORD
    - DB_READ_REPLICA_HOSTS
    - ECS*CLUSTER_GRAASP*{ENV}
    - ECS*SERVICE_GRAASP*{ENV}
    - H5P*CONTENT_BUCKET*{ENV}
    - H5P*CONTENT_REGION*{ENV}
    - REDIS*HOST*{ENV}
    - S3*FILE_ITEM_BUCKET*{ENV}
    - S3_FILE_ITEM_REGION
    - MEILISEARCH_MASTER_KEY
  - Library
    - AWS*REGION*{ENV}
    - ECS*CLUSTER_GRAASP_EXPLORE*{ENV}
    - ECS*SERVICE_GRAASP_EXPLORE*{ENV}
    - CONTAINER*NAME_GRAASP_EXPLORE*{ENV} ("graasp-library")
  - Builder
    - AWS*REGION*{ENV}
    - AWS*S3_BUCKET_NAME_GRAASP_COMPOSE*{ENV}
    - CLOUDFRONT*DISTRIBUTION_GRAASP_COMPOSE*{ENV}
    - VITE_H5P_INTEGRATION_URL (i.e `https://{bucket domain}/h5p-integration/index.html`)
  - Player
    - AWS*REGION*{ENV}
    - AWS*S3_BUCKET_NAME_GRAASP_PERFORM*{ENV}
    - CLOUDFRONT*DISTRIBUTION_GRAASP_PERFORM*{ENV}
    - VITE_GRAASP_H5P_INTEGRATION_URL (i.e `https://{bucket domain}/h5p-integration/index.html`)
  - Auth
    - AWS*REGION*{ENV}
    - AWS*S3_BUCKET_NAME_GRAASP_AUTH*{ENV}
    - CLOUDFRONT*DISTRIBUTION_GRAASP_AUTH*{ENV}
  - Account
    - AWS*REGION*{ENV}
    - AWS*S3_BUCKET_NAME_GRAASP_ACCOUNT*{ENV}
    - CLOUDFRONT*DISTRIBUTION_GRAASP_ACCOUNT*{ENV}
  - Analytics
    - AWS*REGION*{ENV}
    - AWS*S3_BUCKET_NAME_GRAASP_RESEARCH*{ENV}
    - CLOUDFRONT*DISTRIBUTION_GRAASP_RESEARCH*{ENV}
  - Admin
    - No GitHub action currently, in development
  - Apps
    - Sync existing bucket to new bucket
      - i.e. `aws s3 sync s3://graasp-apps-development s3://graasp-dev-apps --acl public-read --follow-symlinks`
      - **If the buckets are in different region you will need more arguments:** `aws s3 sync s3://graasp-apps-staging s3://graasp-staging-apps --acl public-read --follow-symlinks --source-region eu-central-1 --region eu-central-2``
      - Update CI deploy for apps
        - AWS*S3_BUCKET_NAME_APPS*{ENV} (organization secret)
        - CLOUDFRONT*DISTRIBUTION_APPS*{ENV} (organization secret)
  - assets
    - Sync existing bucket to new bucket
      - i.e. `aws s3 sync s3://graasp-assets-development s3://graasp-dev-assets --acl public-read --follow-symlinks`
  - file-items
    - Sync existing bucket to new bucket
      - i.e. `aws s3 sync s3://graasp-s3-file-items-development s3://graasp-dev-file-items --follow-symlinks`
  - h5p
    - Sync existing bucket to new bucket
      - i.e. `aws s3 sync s3://graasp-s3-h5p-development s3://graasp-dev-h5p --follow-symlinks`
    - There are multiple hardcoded reference to the bucket url in `h5p-integration/index.html`, make sure to replace those with the new name or h5p won't work.
- Copy RDS content to the new database (for both databases)
  - **AWS unfortunately doesn't allow to restore a snapshot to an existing database, so we have to restore it manually and then sync it with our Terraform state.**
  - Make a snapshot of the existing database
  - If you already ran Terraform, you will have an empty new database, rename it or delete it
  - (Copy the snapshot to the new region, if the new database is in a different region)
    - https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CopySnapshot.html
  - For Etherpad, you might as well upgrade the snapshot to Postgres 15 before restoring.
    - Also Etherpad seems to use 400gb of IOPS storage sometimes, reducing storage space in not possible in RDS, so in staging, I restored the database manually with dumps: https://docs.aws.amazon.com/dms/latest/sbs/chap-manageddatabases.postgresql-rds-postgresql-full-load-pd_dump.html
  - Restore this snapshot to a new database with the same name expected by Terraform (for example "graasp-dev")
    - Make sure to configure the database as close to the Terraform configuration as possible (security groups etc... use the existing ones)
  - Now we have to import this new database to the existing terraform state (see example for dev environment)
    - `cd cdktf.out/stacks/graasp-dev`
    - `terraform state list` (look for you database)
    - `terraform state rm module.graasp-dev-postgres_db_F1D5DB7A.module.db_instance.aws_db_instance.this[0]`
    - `terraform import module.graasp-dev-postgres_db_F1D5DB7A.module.db_instance.aws_db_instance.this[0] <your database identifier>` (i.e "graasp-dev-etherpad")
  - Now that the snapshotted database has been imported, you can run `yarn run cdktf deploy` again to align the configuration with the infrastructure as code.
  - Reboot the database if needed (check parameter group options)
- Update Route53 records to points to the new Cloudfronts and load balancer.
- Check that everything is working correctly
  - Etherpad
  - H5P
  - apps
  - Meilisearch
  - File upload
  - ...
- EC2
  - Install psql

```shell
  sudo yum update
  sudo yum install postgresql15
  psql --version
```

- Delete the old infrastructure

# Architecture

Some of the resources have been wrapped in custom `Construct` type to simplify usage (ECS cluster, Postgres...) and use sane defaults adapted to Graasp. For other ressources, we directly use the terraform provided construct. This can be improved if better abstractions are needed. Indeed, the current architecture was created by mapping the manually created AWS infrastructure to code, to perform the migration, but it can be perfected now that Terraform manages the infrastructure.

Some example of the possible improvements:

- Manage the zones and DNS records directly with Terraform
- During the migration to IAC, it was discovered that we are only using public subnets in our VPC. This means everything in graasp is addressable from the Internet. This is mitagated by security groups, which only allows traffic from authorized clients. But it might be a good idea to use private subnets, it means however still having public subnets for the application load balancer and routing from public to private subnets.
- Use more strong types: a lot of resources can currently take arbitrary strings for configuration. See `AllowedRegion` for an example of improving a configuration type.
- Terraform do not manage the deployments, it makes the infrastructure available for the CI/CD to act. Make the CI/CD more generic (instead of one workflow per env), then create a pipeline to deploy a generic dev environment (infra followed by deploy), to have ephemereal dev environments.
- Separating "static" resources in different stacks. For example, by putting ECR repo in a different stack for each env, we could destroy everything else, while keeping image history.
- Instead of using long-lived AWS credentials, use Github OIDC integration (see https://github.com/aws-actions/configure-aws-credentials#oidc). This allow workflows to assume a specific AWS role for just the duration of the workflow.
  - This would also allow a workflow to only assume a role for its own env, preventing someone to rewrite the workflow to run on another env. See https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services

# Troubleshoot

## Importing an existing ressource

If something has been created manually on AWS, you can import it into the terraform state (if most of the config matches), so that you don't have to recreate it.

For example for importing an existing ECR repository:

```bash
yarn run cdktf plan # synth and look at plan
cat cdktf.out/stacks/[your stack]/cdk.tf.json jq '.resource.aws_ecr_repository'
# Find the "terraform id" of the resource you want to import to
# Here it would be something like "aws_ecr_repository.graasp-iac-development-ecr"
terraform import aws_ecr_repository.graasp-iac-development-ecr graasp # Import to terraform id from target id (here graasp ecr repo, but can often be an AWS ARN)
yarn run cdktf plan # your plan should stop trying to create the resource.
```

## If deployments break

It is possible that after some time deployments will break with an error similar to:
```
            │ Error: Failed to query available provider packages
            │ 
            │ Could not retrieve the list of available versions for provider hashicorp/aws:
            │ no available releases match the given constraints >= 5.46.0, 5.49.0, >=
            │ 5.59.0, >= 5.62.0

```

In this case the fix is usually to update the `@cdktf/provider-aws` dependency. Using `yarn upgrade-interactive` it is easy to do.
