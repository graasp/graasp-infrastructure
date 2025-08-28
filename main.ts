import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';
import { DataAwsEcrRepository } from '@cdktf/provider-aws/lib/data-aws-ecr-repository';
import { EcrLifecyclePolicy } from '@cdktf/provider-aws/lib/ecr-lifecycle-policy';
import { EcrRepository } from '@cdktf/provider-aws/lib/ecr-repository';
import { LbListenerRuleCondition } from '@cdktf/provider-aws/lib/lb-listener-rule';
import {
  AwsProvider,
  AwsProviderAssumeRole,
} from '@cdktf/provider-aws/lib/provider';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { App, S3Backend, TerraformStack, TerraformVariable } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from './.gen/modules/vpc';
import { CONFIG } from './config';
import { BaremetalService } from './constructs/baremetal_service';
import { GraaspS3Bucket } from './constructs/bucket';
import {
  createMaintenanceFunction,
  makeCloudfront,
} from './constructs/cloudfront';
import { Cluster, createContainerDefinitions } from './constructs/cluster';
import { GateKeeper } from './constructs/gate_keeper';
import { LoadBalancer } from './constructs/load_balancer';
import { PostgresDB } from './constructs/postgres';
import {
  AllowedSecurityGroupInfo,
  securityGroupAllowMultipleOtherSecurityGroups,
  securityGroupEgressOnly,
  securityGroupOnlyAllowAnotherSecurityGroup,
} from './constructs/security_group';
import {
  AllowedRegion,
  Environment,
  EnvironmentConfig,
  GraaspWebsiteConfig,
  buildPostgresConnectionString,
  envCorsRegex,
  envDomain,
  envEmail,
  envName,
  getMaintenanceHeaderPair,
  isServiceActive,
  subdomainForEnv,
  toEnvVar,
  validateInfraState,
} from './utils';

const DEFAULT_REGION = AllowedRegion.Frankfurt;
const CERTIFICATE_REGION = 'us-east-1';

const SHARED_TAGS = { 'terraform-managed': 'true' };

const ROLE_BY_ENV: Record<Environment, AwsProviderAssumeRole[]> = {
  [Environment.DEV]: [{ roleArn: 'arn:aws:iam::299720865162:role/terraform' }],
  [Environment.STAGING]: [
    { roleArn: 'arn:aws:iam::348555061219:role/terraform' },
  ],
  [Environment.PRODUCTION]: [
    { roleArn: 'arn:aws:iam::592217263685:role/terraform' },
  ],
};

class GraaspStack extends TerraformStack {
  constructor(scope: Construct, id: string, environment: EnvironmentConfig) {
    super(scope, id);

    if (environment.env === Environment.STAGING) {
      // we want to delete the staging stack
      return;
    }

    const BACKEND_PORT = 3111;
    const NUDENET_PORT = 8080;
    const LIBRARY_PORT = 3000;
    const ETHERPAD_PORT = 9001;
    const MEILISEARCH_PORT = 7700;
    const MEILISEARCH_HOSTNAME = 'graasp-meilisearch';
    const IFRAMELY_PORT = 8061;
    const IFRAMELY_HOSTNAME = 'graasp-iframely';
    const REDIS_PORT = 6379;
    const REDIS_HOSTNAME = 'graasp-redis';
    const UMAMI_PORT = 3000;

    new AwsProvider(this, 'AWS', {
      region: environment.region,
      assumeRole: ROLE_BY_ENV[environment.env],
      defaultTags: [{ tags: SHARED_TAGS }],
    });

    // This is where the state is stored
    new S3Backend(this, {
      bucket: 'graasp-terraform-state',
      key: id,
      region: AllowedRegion.Zurich,
      encrypt: true,
      // we should be able to remove this since it has been fixed in Nov 2023 (version 1.6.0)
      // skipRegionValidation: true, // Zurich region is invalid with current version https://github.com/hashicorp/terraform-provider-aws/issues/28072
    });

    const certificateProvider = new AwsProvider(this, 'AWS_US_EAST', {
      region: CERTIFICATE_REGION,
      assumeRole: ROLE_BY_ENV[environment.env],
      defaultTags: [{ tags: SHARED_TAGS }],
      alias: 'us_east',
    });

    const vpc = new Vpc(this, 'vpc', {
      name: id,
      cidr: '172.32.0.0/16',
      // Use 3 availability zones in our region
      azs: ['a', 'b', 'c'].map((i) => `${environment.region}${i}`),
      publicSubnets: ['172.32.1.0/24', '172.32.2.0/24', '172.32.3.0/24'],
    });

    if (!vpc.azs || vpc.azs.length < 3) {
      throw new Error('Must define at least 3 availability zones in the VPC');
    }

    // Certificate used for accessing apps - Must be an existing valid certificate
    const sslCertificateCloudfront = new DataAwsAcmCertificate(
      this,
      `${id}-acm-cert`,
      {
        domain: envDomain(environment),
        mostRecent: true,
        types: ['AMAZON_ISSUED'],
        provider: certificateProvider, // ACM certificate must be in US region
      },
    );

    // Certificate needs to be in the same region than the load balancer, so we can't use the same than Cloudfront
    const sslCertificate = new DataAwsAcmCertificate(
      this,
      `${id}-acm-cert-lb`,
      {
        domain: envDomain(environment),
        mostRecent: true,
        types: ['AMAZON_ISSUED'],
      },
    );

    // define the maintenance header rule
    const maintenanceHeaderValues = getMaintenanceHeaderPair(environment);

    const maintenanceHeaderRule = maintenanceHeaderValues
      ? ({
          httpHeader: {
            httpHeaderName: maintenanceHeaderValues.name,
            values: [maintenanceHeaderValues.value],
          },
        } satisfies LbListenerRuleCondition)
      : undefined;
    const ruleConditions = maintenanceHeaderRule ? [maintenanceHeaderRule] : [];

    const cluster = new Cluster(this, id, vpc);
    const loadBalancer = new LoadBalancer(
      this,
      id,
      vpc,
      sslCertificate,
      environment,
    );
    loadBalancer.setupRedirections(environment, ruleConditions);

    // define security groups allowing ingress trafic from the load-balancer
    const loadBalancerAllowedSecurityGroupInfo = {
      groupId: loadBalancer.securityGroup.id,
      targetName: 'load-balancer',
    } satisfies AllowedSecurityGroupInfo;
    const backendSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-backend`,
      vpc.vpcIdOutput,
      loadBalancerAllowedSecurityGroupInfo,
      BACKEND_PORT,
    );
    const workerSecurityGroup = securityGroupEgressOnly(
      this,
      `${id}-workers`,
      vpc.vpcIdOutput,
    );
    const librarySecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-library`,
      vpc.vpcIdOutput,
      loadBalancerAllowedSecurityGroupInfo,
      LIBRARY_PORT,
    );
    const etherpadSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-etherpad`,
      vpc.vpcIdOutput,
      loadBalancerAllowedSecurityGroupInfo,
      ETHERPAD_PORT,
    );
    const umamiSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-umami`,
      vpc.vpcIdOutput,
      loadBalancerAllowedSecurityGroupInfo,
      UMAMI_PORT,
    );
    const migrateServiceSecurityGroup =
      securityGroupOnlyAllowAnotherSecurityGroup(
        this,
        `${id}-migrate`,
        vpc.vpcIdOutput,
        loadBalancerAllowedSecurityGroupInfo,
        BACKEND_PORT,
      );

    const migrationServiceAllowedSecurityGroupInfo = {
      groupId: migrateServiceSecurityGroup.id,
      targetName: 'graasp-migrate',
    } satisfies AllowedSecurityGroupInfo;

    // define security groups accepting ingress trafic from the backend
    const backendAllowedSecurityGroupInfo = {
      groupId: backendSecurityGroup.id,
      targetName: 'graasp-backend',
    } satisfies AllowedSecurityGroupInfo;

    // define security groups accepting ingress trafic from the backend
    const workersServiceAllowedSecurityGroupInfo = {
      groupId: workerSecurityGroup.id,
      targetName: 'graasp-workers',
    } satisfies AllowedSecurityGroupInfo;

    const meilisearchSecurityGroup =
      securityGroupAllowMultipleOtherSecurityGroups(
        this,
        `${id}-meilisearch`,
        vpc.vpcIdOutput,
        [
          backendAllowedSecurityGroupInfo,
          workersServiceAllowedSecurityGroupInfo,
        ],
        MEILISEARCH_PORT,
      );
    const iframelySecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-iframely`,
      vpc.vpcIdOutput,
      backendAllowedSecurityGroupInfo,
      IFRAMELY_PORT,
    );
    const redisSecurityGroup = securityGroupAllowMultipleOtherSecurityGroups(
      this,
      `${id}-redis`,
      vpc.vpcIdOutput,
      [backendAllowedSecurityGroupInfo, workersServiceAllowedSecurityGroupInfo],
      REDIS_PORT,
    );

    // --- Secrets
    const dbPassword = new TerraformVariable(this, 'GRAASP_DB_PASSWORD', {
      nullable: false,
      type: 'string',
      description: 'Admin password for the graasp database',
      sensitive: true,
    });
    const umamiDbUserPassword = new TerraformVariable(
      this,
      'UMAMI_DB_PASSWORD',
      {
        nullable: false,
        type: 'string',
        description: 'Umami user password for the postgresql database',
        sensitive: true,
      },
    );
    const etherpadDbPassword = new TerraformVariable(
      this,
      'ETHERPAD_DB_PASSWORD',
      {
        nullable: false,
        type: 'string',
        description: 'Admin password for the etherpad database',
        sensitive: true,
      },
    );
    const graasperID = new TerraformVariable(this, 'GRAASPER_ID', {
      nullable: false,
      type: 'string',
      description: 'Graasper user Id for collections in the library',
      sensitive: false,
    });
    const appsPublisherID = new TerraformVariable(this, 'APPS_PUBLISHER_ID', {
      nullable: false,
      type: 'string',
      description: 'Graasp apps publisher Id for apps list in the builder',
      sensitive: false,
    });
    const mailerConnection = new TerraformVariable(this, 'MAILER_CONNECTION', {
      nullable: false,
      type: 'string',
      description: 'Connection Url for the SMTP server',
      sensitive: true,
    });
    const sentryDSN = new TerraformVariable(this, 'SENTRY_DSN', {
      nullable: true,
      type: 'string',
      description: 'Sentry DSN for reporting errors',
      sensitive: false,
    });
    const openAiOrgId = new TerraformVariable(this, 'OPENAI_ORG_ID', {
      nullable: false,
      type: 'string',
      description: 'OpenAI organisation Identifier',
      sensitive: false,
    });
    const openAiApiKey = new TerraformVariable(this, 'OPENAI_API_KEY', {
      nullable: false,
      type: 'string',
      description: 'OpenAI API Key',
      sensitive: true,
    });
    const recaptchaSecretKey = new TerraformVariable(
      this,
      'RECAPTCHA_SECRET_KEY',
      {
        nullable: false,
        type: 'string',
        description: 'Recaptcha secret key for bot prevention',
        sensitive: true,
      },
    );
    const meilisearchRebuildSecret = new TerraformVariable(
      this,
      'MEILISEARCH_REBUILD_SECRET',
      {
        nullable: false,
        type: 'string',
        description:
          'Meilisearch rebuild secret (used to trigger a rebuild of the search index)',
        sensitive: true,
      },
    );
    const geolocationApiKey = new TerraformVariable(
      this,
      'GEOLOCATION_API_KEY',
      {
        nullable: false,
        type: 'string',
        description: 'API key for the geolocation external API',
        sensitive: true,
      },
    );
    const etherpadApiKey = new TerraformVariable(this, 'ETHERPAD_API_KEY', {
      nullable: false,
      type: 'string',
      description: 'API key for etherpad communication',
      sensitive: true,
    });
    const h5pAccessKeyId = new TerraformVariable(this, 'H5P_ACCESS_KEY_ID', {
      nullable: false,
      type: 'string',
      description: 'H5P Bucket access key id',
      sensitive: true,
    });
    const h5pAccessSecretKeyId = new TerraformVariable(
      this,
      'H5P_ACCESS_SECRET_KEY_ID',
      {
        nullable: false,
        type: 'string',
        description: 'H5P Bucket access secret key id',
        sensitive: true,
      },
    );
    const s3AccessKeyId = new TerraformVariable(this, 'S3_ACCESS_KEY_ID', {
      nullable: false,
      type: 'string',
      description: 'S3 file Bucket access key id',
      sensitive: true,
    });
    const s3AccessSecretKeyId = new TerraformVariable(
      this,
      'S3_ACCESS_SECRET_KEY_ID',
      {
        nullable: false,
        type: 'string',
        description: 'S3 file Bucket access secret key id',
        sensitive: true,
      },
    );
    const appsJwtSecret = new TerraformVariable(this, 'APPS_JWT_SECRET', {
      nullable: false,
      type: 'string',
      description: 'JWT secret for signing apps login tokens',
      sensitive: true,
    });
    const jwtSecret = new TerraformVariable(this, 'JWT_SECRET', {
      nullable: false,
      type: 'string',
      description: 'JWT secret for signing login tokens',
      sensitive: true,
    });
    const secureSessionJwtSecret = new TerraformVariable(
      this,
      'SECURE_SESSION_SECRET_KEY',
      {
        nullable: false,
        type: 'string',
        description: 'JWT secret for signing session cookies',
        sensitive: true,
      },
    );
    const passwordResetJwtSecret = new TerraformVariable(
      this,
      'PASSWORD_RESET_JWT_SECRET',
      {
        nullable: false,
        type: 'string',
        description: 'JWT secret for signing password reset requests',
        sensitive: true,
      },
    );
    const emailChangeJwtSecret = new TerraformVariable(
      this,
      'EMAIL_CHANGE_JWT_SECRET',
      {
        nullable: false,
        type: 'string',
        description: 'JWT secret for signing email change requests',
        sensitive: true,
      },
    );
    const umamiJwtSecret = new TerraformVariable(this, 'UMAMI_JWT_SECRET', {
      nullable: false,
      type: 'string',
      description: 'JWT secret for umami service',
      sensitive: true,
    });

    const gatekeeper = new GateKeeper(this, id, vpc);
    // allow communication between the gatekeeper and meilisearch
    new VpcSecurityGroupIngressRule(
      this,
      `${id}-allow-gatekeeper-on-meilisearch`,
      {
        referencedSecurityGroupId: gatekeeper.instance.securityGroup.id, // allowed source security group
        ipProtocol: 'tcp',
        securityGroupId: meilisearchSecurityGroup.id,
        // port range for ingress trafic
        fromPort: MEILISEARCH_PORT,
        toPort: MEILISEARCH_PORT,
      },
    );

    const collaborativeIdeation =
      // This service is currently only enabled in the "dev" environnement.
      // We can move this to a config-based decision so it is possible to enable or disable a service depending on the env.
      // For now we can keep it like this, we will change if we need.
      environment.env === Environment.DEV
        ? new BaremetalService(
            this,
            id,
            vpc,
            {
              name: 'collab',
              keyName: 'collab',
              instanceAmi: 'ami-01c79f8fca6bc28c3', // aws linux for arm based graviton instance
              instanceType: 't4g.micro',
              allowedSecurityGroups: [
                { ...loadBalancerAllowedSecurityGroupInfo, port: 3000 },
              ],
            },
            isServiceActive(environment).collab,
            {
              loadBalancer: loadBalancer,
              priority: 9,
              host: subdomainForEnv('collab', environment),
              // TODO: ensure this is the correct port
              port: 3000,
              // TODO: ensure this is the correct path
              healthCheckPath: '/health',
              ruleConditions,
            },
          )
        : undefined;

    const admin = new BaremetalService(
      this,
      id,
      vpc,
      {
        name: 'admin',
        keyName: 'phoenix', // needs to exist in the env
        instanceAmi: 'ami-01c79f8fca6bc28c3', // aws linux for arm based graviton instance
        instanceType: 't4g.micro',
        allowedSecurityGroups: [
          { ...loadBalancerAllowedSecurityGroupInfo, port: 443 },
        ],
      },
      isServiceActive(environment).graasp,
      {
        loadBalancer: loadBalancer,
        priority: 8,
        host: subdomainForEnv('admin', environment),
        // TODO: ensure this is the correct port
        port: 443,
        // TODO: ensure this is the correct path
        healthCheckPath: '/up',
        ruleConditions,
      },
    );

    // define security groups needing access to the database
    const umamiAllowedSecurityGroupInfo = {
      groupId: umamiSecurityGroup.id,
      targetName: 'umami',
    } satisfies AllowedSecurityGroupInfo;

    const etherpadAllowedSecurityGroupInfo = {
      groupId: etherpadSecurityGroup.id,
      targetName: 'etherpad',
    } satisfies AllowedSecurityGroupInfo;

    const adminAllowedSecurityGroupInfo = {
      groupId: admin.instance.securityGroup.id,
      targetName: 'admin',
    } satisfies AllowedSecurityGroupInfo;

    const allowedSecurityGroupsDB = [
      backendAllowedSecurityGroupInfo,
      workersServiceAllowedSecurityGroupInfo,
      umamiAllowedSecurityGroupInfo,
      etherpadAllowedSecurityGroupInfo,
      migrationServiceAllowedSecurityGroupInfo,
      adminAllowedSecurityGroupInfo,
    ];
    // add the collab security group only if the collab service is defined
    if (collaborativeIdeation) {
      allowedSecurityGroupsDB.push({
        groupId: collaborativeIdeation.instance.securityGroup.id,
        targetName: 'collab',
      });
    }

    const backendDb = new PostgresDB(
      this,
      id,
      'graasp',
      'graasp',
      dbPassword,
      vpc,
      allowedSecurityGroupsDB,
      CONFIG[environment.env].dbConfig.graasp.enableReplication,
      isServiceActive(environment).database,
      CONFIG[environment.env].dbConfig.graasp.backupRetentionPeriod,
      undefined,
      gatekeeper.instance.securityGroup,
    );

    const DB_CONNECTION = buildPostgresConnectionString({
      host: backendDb.instance.dbInstanceAddressOutput,
      port: '5432',
      name: 'graasp',
      username: backendDb.instance.dbInstanceUsernameOutput,
      password: toEnvVar(dbPassword),
    });

    // We do not let Terraform manage ECR repository yet. Also allows destroying the stack without destroying the repos.
    const graaspECR = new DataAwsEcrRepository(this, `${id}-ecr`, {
      name: 'graasp',
    });
    const etherpadECR = new DataAwsEcrRepository(this, `${id}-etherpad-ecr`, {
      name: 'graasp/etherpad',
    });
    const libraryECR = new DataAwsEcrRepository(this, `${id}-explore-ecr`, {
      name: 'graasp/explore',
    });
    const adminECR = new EcrRepository(this, `${id}-admin-ecr`, {
      name: 'graasp/admin',
    });
    // ecr repository policy
    new EcrLifecyclePolicy(this, `${id}-admin-ecr-lifecycle`, {
      repository: adminECR.name,
      policy: JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            selection: {
              tagStatus: 'untagged',
              countType: 'sinceImagePushed',
              countUnit: 'days',
              countNumber: 1,
            },
            action: {
              type: 'expire',
            },
          },
          {
            rulePriority: 2,
            description: 'Keep only the last 2 images',
            selection: {
              tagStatus: 'any',
              countType: 'imageCountMoreThan',
              countNumber: 2,
            },
            action: {
              type: 'expire',
            },
          },
        ],
      }),
    });

    const meilisearchMasterKey = new TerraformVariable(
      this,
      'MEILISEARCH_MASTER_KEY',
      {
        nullable: false,
        type: 'string',
        description: 'Meilisearch master key',
        sensitive: true,
      },
    );
    const meilisearchDefinition = createContainerDefinitions(
      'meilisearch',
      'getmeili/meilisearch',
      'v1.8',
      [{ hostPort: MEILISEARCH_PORT, containerPort: MEILISEARCH_PORT }],
      {
        MEILI_ENV: 'production',
        MEILI_MASTER_KEY: toEnvVar(meilisearchMasterKey),
        MEILI_NO_ANALYTICS: 'true',
        MEILI_EXPERIMENTAL_LOGS_MODE: 'json',
      },
      environment,
    );

    const backendEnv = {
      // constants
      SENTRY_ENV: envName(environment),
      LOG_LEVEL: 'info', // QUESTION: Should this be a var ?
      H5P_FILE_STORAGE_TYPE: 's3',
      FILE_STORAGE_TYPE: 's3',
      DB_CONNECTION_POOL_SIZE: '10',
      GEOLOCATION_API_HOST: 'https://api.geoapify.com/v1/geocode', // QUESTION: should this be a constant in the code instead and we only expose the API_KEY var
      IMAGE_CLASSIFIER_API: 'http://localhost:8080/sync', // a constant for now, later might be inside a queue
      CORS_ORIGIN_REGEX: envCorsRegex(environment),
      H5P_PATH_PREFIX: 'h5p-content/', // constant
      PORT: `${BACKEND_PORT}`, // from infra
      HOSTNAME: '0.0.0.0', // IP to listen to (bind to all ips)

      // can be deducted from the infra itself
      S3_FILE_ITEM_REGION: environment.region,
      H5P_CONTENT_REGION: environment.region,
      REDIS_CONNECTION: `redis://${REDIS_HOSTNAME}:${REDIS_PORT}`,
      EMBEDDED_LINK_ITEM_IFRAMELY_HREF_ORIGIN: `http://${IFRAMELY_HOSTNAME}:${IFRAMELY_PORT}`,
      MEILISEARCH_URL: `http://${MEILISEARCH_HOSTNAME}:${MEILISEARCH_PORT}`,
      DB_CONNECTION,
      COOKIE_DOMAIN: subdomainForEnv('', environment), // i.e: '.dev.graasp.org'
      ETHERPAD_COOKIE_DOMAIN: subdomainForEnv('', environment), // i.e: '.dev.graasp.org'
      PUBLIC_URL: `https://${subdomainForEnv('api', environment)}`,
      CLIENT_HOST: `https://${envDomain(environment)}`, // apex domain // FIXME: should be named CLIENT_URL
      LIBRARY_CLIENT_HOST: `https://${subdomainForEnv('library', environment)}`, // FIXME should be named LIBRARY_URL
      ETHERPAD_URL: `https://${subdomainForEnv('etherpad', environment)}`,
      S3_FILE_ITEM_BUCKET: `${id}-file-items`, // i.e: 'graasp-dev-file-items'
      H5P_CONTENT_BUCKET: `${id}-h5p`, // i.e: 'graasp-dev-h5p'
      MAILER_CONFIG_FROM_EMAIL: envEmail('noreply', environment), // i.e: 'noreply.dev@graasp.org',

      // env vars
      MAILER_CONNECTION: toEnvVar(mailerConnection),
      APPS_PUBLISHER_ID: toEnvVar(appsPublisherID),
      GRAASPER_CREATOR_ID: toEnvVar(graasperID),
      SENTRY_DSN: toEnvVar(sentryDSN),
      OPENAI_ORG_ID: toEnvVar(openAiOrgId),

      // sensitive secrets
      ETHERPAD_API_KEY: toEnvVar(etherpadApiKey),
      GEOLOCATION_API_KEY: toEnvVar(geolocationApiKey),
      H5P_CONTENT_ACCESS_KEY_ID: toEnvVar(h5pAccessKeyId),
      H5P_CONTENT_SECRET_ACCESS_KEY_ID: toEnvVar(h5pAccessSecretKeyId),
      S3_FILE_ITEM_ACCESS_KEY_ID: toEnvVar(s3AccessKeyId),
      S3_FILE_ITEM_SECRET_ACCESS_KEY: toEnvVar(s3AccessSecretKeyId),
      MEILISEARCH_REBUILD_SECRET: toEnvVar(meilisearchRebuildSecret),
      MEILISEARCH_MASTER_KEY: toEnvVar(meilisearchMasterKey), // also defined for meilisearch container
      RECAPTCHA_SECRET_ACCESS_KEY: toEnvVar(recaptchaSecretKey),
      OPENAI_API_KEY: toEnvVar(openAiApiKey),

      JWT_SECRET: toEnvVar(jwtSecret),
      SECURE_SESSION_SECRET_KEY: toEnvVar(secureSessionJwtSecret),
      PASSWORD_RESET_JWT_SECRET: toEnvVar(passwordResetJwtSecret),
      EMAIL_CHANGE_JWT_SECRET: toEnvVar(emailChangeJwtSecret),
      APPS_JWT_SECRET: toEnvVar(appsJwtSecret),
    };

    // Task for the backend
    const coreDefinition = createContainerDefinitions(
      'core',
      `${graaspECR.repositoryUrl}`,
      'core-latest',
      [{ hostPort: BACKEND_PORT, containerPort: BACKEND_PORT }],
      backendEnv,
      environment,
    );
    const nudenetDefinition = createContainerDefinitions(
      'nudenet',
      'notaitech/nudenet',
      'classifier',
      [{ hostPort: NUDENET_PORT, containerPort: NUDENET_PORT }],
      {}, // does not need env vars
      environment,
    );

    // currently it is the same, but it could be less in the future
    const workerEnv = backendEnv;
    const workersDefinition = createContainerDefinitions(
      'graasp-worker',
      `${graaspECR.repositoryUrl}`,
      'workers-latest',
      // no port mappings necessary
      [],
      workerEnv,
      environment,
    );

    const libraryDefinition = createContainerDefinitions(
      'graasp-library',
      `${libraryECR.repositoryUrl}`,
      'latest',
      [{ hostPort: LIBRARY_PORT, containerPort: LIBRARY_PORT }],
      {
        VITE_API_HOST: `https://${subdomainForEnv('api', environment)}`,
        VITE_CLIENT_HOST: `https://${envDomain(environment)}`, // apex domain
        VITE_HOST: `https://${subdomainForEnv('library', environment)}`,
      },
      environment,
    );

    // Definitions for third party services changes less often and are managed by Terraform.
    const etherpadDefinition = createContainerDefinitions(
      'etherpad',
      etherpadECR.repositoryUrl,
      'latest',
      [{ hostPort: ETHERPAD_PORT, containerPort: ETHERPAD_PORT }],
      {
        DB_HOST: backendDb.instance.dbInstanceAddressOutput,
        DB_NAME: 'etherpad',
        DB_PASS: toEnvVar(etherpadDbPassword),
        DB_PORT: '5432',
        DB_TYPE: 'postgres',
        DB_USER: 'etherpad',
        EDIT_ONLY: 'true',
        PORT: ETHERPAD_PORT.toString(),
        MINIFY: 'false',
      },
      environment,
    );

    const iframelyDefinition = createContainerDefinitions(
      'iframely',
      'graasp/iframely',
      'latest',
      [{ hostPort: IFRAMELY_PORT, containerPort: IFRAMELY_PORT }],
      { NODE_ENV: 'production' },
      environment,
    );

    const redisDefinition = createContainerDefinitions(
      'redis',
      'redis',
      '7-alpine',
      [{ hostPort: REDIS_PORT, containerPort: REDIS_PORT }],
      {},
      environment,
    );

    const umamiDefinition = createContainerDefinitions(
      'umami',
      'ghcr.io/umami-software/umami',
      'postgresql-latest',
      [{ hostPort: UMAMI_PORT, containerPort: UMAMI_PORT }],
      {
        DATABASE_URL: buildPostgresConnectionString({
          host: backendDb.instance.dbInstanceAddressOutput,
          port: '5432',
          name: 'umami',
          username: 'umami',
          password: toEnvVar(umamiDbUserPassword),
        }),
        APP_SECRET: toEnvVar(umamiJwtSecret),
        DISABLE_TELEMETRY: '1',
        HOSTNAME: '0.0.0.0', // needed for the app to bind to localhost, otherwise never answers the health-checks
      },
      environment,
    );

    const graaspServicesActive = isServiceActive(environment).graasp;
    // backend
    cluster.addService(
      'graasp',
      CONFIG[environment.env].ecsConfig.graasp.taskCount,
      {
        containerDefinitions: [coreDefinition, nudenetDefinition],
        cpu: CONFIG[environment.env].ecsConfig.graasp.cpu,
        memory: CONFIG[environment.env].ecsConfig.graasp.memory,
      },
      graaspServicesActive,
      backendSecurityGroup,
      undefined,
      {
        predefinedMetricSpecification: {
          predefinedMetricType: 'ECSServiceAverageCPUUtilization',
        },
        targetValue: 70,
        scaleInCooldown: 30,
        scaleOutCooldown: 300,
      },
      {
        loadBalancer: loadBalancer,
        priority: 1,
        host: subdomainForEnv('api', environment),
        port: 80,
        containerPort: BACKEND_PORT,
        containerName: 'core',
        healthCheckPath: '/health',
        ruleConditions,
      },
    );
    // workers
    cluster.addService(
      'workers',
      1,
      {
        containerDefinitions: [workersDefinition],
        cpu: CONFIG[environment.env].ecsConfig.workers.cpu,
        memory: CONFIG[environment.env].ecsConfig.workers.memory,
      },
      graaspServicesActive,
      workerSecurityGroup,
      undefined,
      {
        predefinedMetricSpecification: {
          predefinedMetricType: 'ECSServiceAverageCPUUtilization',
        },
        targetValue: 70,
        scaleInCooldown: 30,
        scaleOutCooldown: 30,
      },
    );

    cluster.addService(
      'graasp-library',
      1,
      { containerDefinitions: [libraryDefinition] },
      graaspServicesActive,
      librarySecurityGroup,
      undefined,
      {
        predefinedMetricSpecification: {
          predefinedMetricType: 'ECSServiceAverageMemoryUtilization',
        },
        targetValue: 80,
        scaleInCooldown: 10,
        scaleOutCooldown: 300,
      },
      {
        loadBalancer: loadBalancer,
        priority: 2,
        host: subdomainForEnv('library', environment),
        port: 80,
        containerName: 'graasp-library',
        containerPort: LIBRARY_PORT,
        healthCheckPath: '/api/status',
        ruleConditions,
      },
    );

    cluster.addService(
      'etherpad',
      1,
      {
        containerDefinitions: [etherpadDefinition],
        cpu: CONFIG[environment.env].ecsConfig.etherpad.cpu,
        memory: CONFIG[environment.env].ecsConfig.etherpad.memory,
      },
      graaspServicesActive,
      etherpadSecurityGroup,
      undefined,
      undefined,
      {
        loadBalancer: loadBalancer,
        priority: 3,
        host: subdomainForEnv('etherpad', environment),
        port: 443,
        containerName: 'etherpad',
        containerPort: ETHERPAD_PORT,
        healthCheckPath: '/',
        ruleConditions,
      },
    );

    cluster.addService(
      'umami',
      1,
      {
        containerDefinitions: [umamiDefinition],
        cpu: CONFIG[environment.env].ecsConfig.umami.cpu,
        memory: CONFIG[environment.env].ecsConfig.umami.memory,
      },
      isServiceActive(environment).umami,
      umamiSecurityGroup,
      { name: 'umami', port: UMAMI_PORT },
      undefined,
      {
        loadBalancer: loadBalancer,
        priority: 4,
        host: subdomainForEnv('umami', environment),
        port: 80,
        containerName: 'umami',
        containerPort: UMAMI_PORT,
        healthCheckPath: '/api/heartbeat',
        ruleConditions:
          // umami service should stay accessible without maintenance unless service is not active.
          isServiceActive(environment).umami ? undefined : ruleConditions,
      },
    );

    cluster.addService(
      'meilisearch',
      1,
      {
        containerDefinitions: [meilisearchDefinition],
        cpu: CONFIG[environment.env].ecsConfig.meilisearch.cpu,
        memory: CONFIG[environment.env].ecsConfig.meilisearch.memory,
      },
      graaspServicesActive,
      meilisearchSecurityGroup,
      { name: MEILISEARCH_HOSTNAME, port: MEILISEARCH_PORT },
    );

    cluster.addService(
      'iframely',
      1,
      {
        containerDefinitions: [iframelyDefinition],
        cpu: CONFIG[environment.env].ecsConfig.iframely.cpu,
        memory: CONFIG[environment.env].ecsConfig.iframely.memory,
      },
      graaspServicesActive,
      iframelySecurityGroup,
      { name: IFRAMELY_HOSTNAME, port: IFRAMELY_PORT },
    );

    cluster.addService(
      'redis',
      1,
      {
        containerDefinitions: [redisDefinition],
        cpu: CONFIG[environment.env].ecsConfig.redis.cpu,
        memory: CONFIG[environment.env].ecsConfig.redis.memory,
      },
      graaspServicesActive,
      redisSecurityGroup,
      { name: REDIS_HOSTNAME, port: REDIS_PORT },
    );

    // migrate
    const migrateDefinition = createContainerDefinitions(
      'migrate',
      graaspECR.repositoryUrl,
      'migrate-latest',
      [],
      {
        DB_CONNECTION,
      },
      environment,
    );
    cluster.addOneOffTask(
      'migrate',
      1,
      isServiceActive(environment).migration,
      {
        containerDefinitions: [migrateDefinition],
        cpu: CONFIG[environment.env].ecsConfig.migrate.cpu,
        memory: CONFIG[environment.env].ecsConfig.migrate.memory,
      },
      migrateServiceSecurityGroup,
    );

    // S3 buckets

    // This has been copied from existing configuration, is it relevant?
    const FILE_ITEM_CORS = [
      {
        allowedHeaders: ['*'],
        allowedMethods: ['GET'],
        allowedOrigins: [`https://${subdomainForEnv('assets', environment)}`],
        exposeHeaders: [],
      },
      {
        allowedHeaders: ['*'],
        allowedMethods: ['HEAD', 'PUT', 'GET', 'DELETE'],
        allowedOrigins: ['null'],
        exposeHeaders: [],
      },
      {
        allowedHeaders: ['*'],
        allowedMethods: ['HEAD', 'GET'],
        allowedOrigins: ['*'],
        exposeHeaders: [],
      },
    ];
    const H5P_CORS = [
      {
        allowedHeaders: ['*'],
        allowedMethods: ['GET'],
        allowedOrigins: [
          `https://${subdomainForEnv('builder', environment)}`,
          `https://${subdomainForEnv('player', environment)}`,
          // apex domain
          `https://${envDomain(environment)}`,
        ],
        exposeHeaders: [],
      },
    ];

    // maintenance
    const maintenanceBucket = new GraaspS3Bucket(
      this,
      `${id}-maintenance`,
      true,
      [],
      undefined,
    );
    if (!maintenanceBucket.websiteConfiguration) {
      throw new Error('Website bucket should have a website configuration');
    }
    makeCloudfront(
      this,
      `${id}-maintenance`,
      'maintenance',
      maintenanceBucket.websiteConfiguration.websiteEndpoint,
      // no need for a function association
      undefined,
      sslCertificateCloudfront,
      environment,
      !!maintenanceBucket.websiteConfiguration,
      false,
    );

    const websites: Record<string, GraaspWebsiteConfig> = {
      apps: { corsConfig: [] },
      assets: { corsConfig: [] },
      h5p: { corsConfig: H5P_CORS, bucketOwnership: 'BucketOwnerEnforced' },
      client: { corsConfig: [], apexDomain: true },
    };

    // define the maintenance function in a function association
    const maintenanceFunc = createMaintenanceFunction(
      this,
      'maintenance-check-function',
      environment,
      maintenanceHeaderValues,
    );

    for (const [website_name, website_config] of Object.entries(websites)) {
      const bucket = new GraaspS3Bucket(
        this,
        `${id}-${website_name}`,
        website_config.s3StaticSite ?? true,
        website_config.corsConfig,
        website_config.bucketOwnership,
      );
      if (!bucket.websiteConfiguration) {
        throw new Error('Website bucket should have a website configuration');
      }
      makeCloudfront(
        this,
        `${id}-${website_name}`,
        website_name,
        bucket.websiteConfiguration.websiteEndpoint,
        maintenanceFunc?.arn,
        sslCertificateCloudfront,
        environment,
        !!bucket.websiteConfiguration,
        website_config.apexDomain,
      );
    }
    // File item storage is private
    new GraaspS3Bucket(this, `${id}-file-items`, false, FILE_ITEM_CORS);
  }
}

const app = new App();

// get the desired infra state
const infraState = validateInfraState(process.env.INFRA_STATE);

// Each stack has its own state stored in a pre created S3 Bucket
new GraaspStack(app, 'graasp-dev', {
  env: Environment.DEV,
  subdomain: 'dev',
  region: DEFAULT_REGION,
  infraState,
});

new GraaspStack(app, 'graasp-staging', {
  env: Environment.STAGING,
  subdomain: 'stage',
  region: AllowedRegion.Zurich,
  infraState,
});

new GraaspStack(app, 'graasp-prod', {
  env: Environment.PRODUCTION,
  region: AllowedRegion.Zurich,
  infraState,
});

app.synth();
