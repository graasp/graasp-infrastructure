import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';
import { DataAwsEcrRepository } from '@cdktf/provider-aws/lib/data-aws-ecr-repository';
import {
  AwsProvider,
  AwsProviderAssumeRole,
} from '@cdktf/provider-aws/lib/provider';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { App, S3Backend, TerraformStack, TerraformVariable } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from './.gen/modules/vpc';
import { CONFIG } from './config';
import { GraaspS3Bucket } from './constructs/bucket';
import { makeCloudfront } from './constructs/cloudfront';
import { Cluster, createContainerDefinitions } from './constructs/cluster';
import { GateKeeper } from './constructs/gate_keeper';
import { LoadBalancer } from './constructs/load_balancer';
import { PostgresDB } from './constructs/postgres';
import {
  AllowedSecurityGroupInfo,
  securityGroupOnlyAllowAnotherSecurityGroup,
} from './constructs/security_group';
import {
  AllowedRegion,
  Environment,
  EnvironmentConfig,
  GraaspWebsiteConfig,
  envDomain,
  subdomainForEnv,
} from './utils';

const DEFAULT_REGION = AllowedRegion.Francfort;
const CERTIFICATE_REGION = 'us-east-1';

const SHARED_TAGS = {
  'terraform-managed': 'true',
};

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

    const BACKEND_PORT = 3111;
    const LIBRARY_PORT = 3005;
    const ETHERPAD_PORT = 9001;
    const MEILISEARCH_PORT = 7700;
    const IFRAMELY_PORT = 8061;
    const REDIS_PORT = 6379;
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

    const cluster = new Cluster(this, id, vpc);
    const loadBalancer = new LoadBalancer(this, id, vpc, sslCertificate);

    // ---- Setup redirections in the load-balancer -----
    // for the go.graasp.org service, redirect to an api endpoint
    loadBalancer.addListenerRuleForHostRedirect(
      'shortener',
      10,
      {
        subDomainOrigin: 'go', // requests from go.graasp.org
        subDomainTarget: 'api', // to api.graasp.org
        pathRewrite: '/items/short-links/#{path}', // rewrite the path to add the correct api route
        // optionally keep query params
        statusCode: 'HTTP_302', // temporary moved
      },
      environment,
    );
    loadBalancer.addListenerRuleForHostRedirect(
      'account',
      11,
      {
        subDomainOrigin: 'account', // requests from go.graasp.org
        subDomainTarget: '', // to graasp.org
        pathRewrite: '/account/#{path}', // rewrite the path to add the correct api route
        // optionally keep query params
        queryRewrite: '#{query}',
        statusCode: 'HTTP_301', // permanently moved
      },
      environment,
    );
    loadBalancer.addListenerRuleForHostRedirect(
      'auth',
      12,
      {
        subDomainOrigin: 'auth', // requests from go.graasp.org
        subDomainTarget: '', // to graasp.org
        pathRewrite: '/auth/#{path}', // rewrite the path to add the correct api route
        // optionally keep query params
        queryRewrite: '#{query}',
        statusCode: 'HTTP_301', // permanently moved
      },
      environment,
    );
    loadBalancer.addListenerRuleForHostRedirect(
      'player',
      13,
      {
        subDomainOrigin: 'player', // requests from go.graasp.org
        subDomainTarget: '', // to graasp.org
        pathRewrite: '/player/#{path}', // rewrite the path to add the correct api route
        // optionally keep query params
        queryRewrite: '#{query}',
        statusCode: 'HTTP_301', // permanently moved
      },
      environment,
    );

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

    // define security groups accepting ingress trafic from the backend
    const backendAllowedSecurityGroupInfo = {
      groupId: backendSecurityGroup.id,
      targetName: 'graasp-backend',
    } satisfies AllowedSecurityGroupInfo;

    const meilisearchSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-meilisearch`,
      vpc.vpcIdOutput,
      backendAllowedSecurityGroupInfo,
      MEILISEARCH_PORT,
    );
    const iframelySecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-iframely`,
      vpc.vpcIdOutput,
      backendAllowedSecurityGroupInfo,
      IFRAMELY_PORT,
    );
    const redisSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-redis`,
      vpc.vpcIdOutput,
      backendAllowedSecurityGroupInfo,
      REDIS_PORT,
    );

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

    // define security groups needing access to the database
    const umamiAllowedSecurityGroupInfo = {
      groupId: umamiSecurityGroup.id,
      targetName: 'umami',
    } satisfies AllowedSecurityGroupInfo;

    const etherpadAllowedSecurityGroupInfo = {
      groupId: etherpadSecurityGroup.id,
      targetName: 'etherpad',
    } satisfies AllowedSecurityGroupInfo;

    const backendDb = new PostgresDB(
      this,
      id,
      'graasp',
      'graasp',
      dbPassword,
      vpc,
      [
        backendAllowedSecurityGroupInfo,
        umamiAllowedSecurityGroupInfo,
        etherpadAllowedSecurityGroupInfo,
      ],
      CONFIG[environment.env].dbConfig.graasp.enableReplication,
      CONFIG[environment.env].dbConfig.graasp.backupRetentionPeriod,
      undefined,
      gatekeeper.instance.securityGroup,
    );

    // We do not let Terraform manage ECR repository yet. Also allows destroying the stack without destroying the repos.
    new DataAwsEcrRepository(this, `${id}-ecr`, {
      name: 'graasp',
    });
    const etherpadECR = new DataAwsEcrRepository(this, `${id}-etherpad-ecr`, {
      name: 'graasp/etherpad',
    });
    new DataAwsEcrRepository(this, `${id}-explore-ecr`, {
      name: 'graasp/explore',
    });

    // Task for the backend
    // This is a dummy task that will be replaced by the CI/CD during deployment
    // Deployment is not managed by Terraform here.
    const graaspDummyBackendDefinition = createContainerDefinitions(
      'graasp',
      'busybox',
      '1.36',
      [
        {
          hostPort: BACKEND_PORT,
          containerPort: BACKEND_PORT,
        },
      ],
      {},
      environment,
      ['/bin/sh', '-c', 'while true; do sleep 30; done'],
    );

    const libraryDummyBackendDefinition = createContainerDefinitions(
      'graasp-library',
      'busybox',
      '1.36',
      [
        {
          hostPort: LIBRARY_PORT,
          containerPort: LIBRARY_PORT,
        },
      ],
      {},
      environment,
      ['/bin/sh', '-c', 'while true; do sleep 30; done'],
    );

    // Definitions for third party services changes less often and are managed by Terraform.
    const etherpadDefinition = createContainerDefinitions(
      'etherpad',
      etherpadECR.repositoryUrl,
      'latest',
      [
        {
          hostPort: ETHERPAD_PORT,
          containerPort: ETHERPAD_PORT,
        },
      ],
      {
        DB_HOST: backendDb.instance.dbInstanceAddressOutput,
        DB_NAME: 'etherpad',
        DB_PASS: `\$\{${etherpadDbPassword.value}\}`,
        DB_PORT: '5432',
        DB_TYPE: 'postgres',
        DB_USER: 'etherpad',
        EDIT_ONLY: 'true',
        PORT: ETHERPAD_PORT.toString(),
        MINIFY: 'false',
      },
      environment,
    );

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
      [
        {
          hostPort: MEILISEARCH_PORT,
          containerPort: MEILISEARCH_PORT,
        },
      ],
      {
        MEILI_ENV: 'production',
        MEILI_MASTER_KEY: `\$\{${meilisearchMasterKey.value}\}`,
        MEILI_NO_ANALYTICS: 'true',
        MEILI_EXPERIMENTAL_LOGS_MODE: 'json',
      },
      environment,
    );

    const iframelyDefinition = createContainerDefinitions(
      'iframely',
      'graasp/iframely',
      'latest',
      [
        {
          hostPort: IFRAMELY_PORT,
          containerPort: IFRAMELY_PORT,
        },
      ],
      {
        NODE_ENV: 'production',
      },
      environment,
    );

    const redisDefinition = createContainerDefinitions(
      'redis',
      'redis',
      '7-alpine',
      [
        {
          hostPort: REDIS_PORT,
          containerPort: REDIS_PORT,
        },
      ],
      {},
      environment,
    );

    const umamiDefinition = createContainerDefinitions(
      'umami',
      'ghcr.io/umami-software/umami',
      'postgresql-latest',
      [
        {
          hostPort: UMAMI_PORT,
          containerPort: UMAMI_PORT,
        },
      ],
      {
        DATABASE_URL: `postgresql://umami:${umamiDbUserPassword}@${backendDb.instance.dbInstanceAddressOutput}:5432/umami`,
        APP_SECRET:
          'a5b20f9ac88eb6d9c2a443664968052ee9f34a3ea8ed1ebe0c0d5c51d5ea78ca',
        DISABLE_TELEMETRY: '1',
        HOSTNAME: '0.0.0.0', // needed for the app to bind to localhost, otherwise never answers the health-checks
      },
      environment,
    );

    // backend
    cluster.addService(
      'graasp',
      CONFIG[environment.env].ecsConfig.graasp.taskCount,
      { containerDefinitions: graaspDummyBackendDefinition, dummy: true },
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
        healthCheckPath: '/health',
      },
    );

    cluster.addService(
      'graasp-library',
      1,
      { containerDefinitions: libraryDummyBackendDefinition, dummy: true },
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
        containerPort: LIBRARY_PORT,
        healthCheckPath: '/api/status',
      },
    );

    cluster.addService(
      'etherpad',
      1,
      {
        containerDefinitions: etherpadDefinition,
        cpu: CONFIG[environment.env].ecsConfig.etherpad.cpu,
        memory: CONFIG[environment.env].ecsConfig.etherpad.memory,
        dummy: false,
      },
      etherpadSecurityGroup,
      undefined,
      undefined,
      {
        loadBalancer: loadBalancer,
        priority: 3,
        host: subdomainForEnv('etherpad', environment),
        port: 443,
        containerPort: ETHERPAD_PORT,
        healthCheckPath: '/',
      },
    );

    cluster.addService(
      'umami',
      1,
      {
        containerDefinitions: umamiDefinition,
        cpu: CONFIG[environment.env].ecsConfig.umami.cpu,
        memory: CONFIG[environment.env].ecsConfig.umami.memory,
        dummy: false,
      },
      umamiSecurityGroup,
      { name: 'umami', port: UMAMI_PORT },
      undefined,
      {
        loadBalancer: loadBalancer,
        priority: 4,
        host: subdomainForEnv('umami', environment),
        port: 80,
        containerPort: UMAMI_PORT,
        healthCheckPath: '/api/heartbeat',
      },
    );

    cluster.addService(
      'meilisearch',
      1,
      {
        containerDefinitions: meilisearchDefinition,
        cpu: CONFIG[environment.env].ecsConfig.meilisearch.cpu,
        memory: CONFIG[environment.env].ecsConfig.meilisearch.memory,
        dummy: false,
      },
      meilisearchSecurityGroup,
      { name: 'graasp-meilisearch', port: MEILISEARCH_PORT },
    );

    cluster.addService(
      'iframely',
      1,
      {
        containerDefinitions: iframelyDefinition,
        cpu: CONFIG[environment.env].ecsConfig.iframely.cpu,
        memory: CONFIG[environment.env].ecsConfig.iframely.memory,
        dummy: false,
      },
      iframelySecurityGroup,
      { name: 'graasp-iframely', port: IFRAMELY_PORT },
    );

    cluster.addService(
      'redis',
      1,
      {
        containerDefinitions: redisDefinition,
        cpu: CONFIG[environment.env].ecsConfig.redis.cpu,
        memory: CONFIG[environment.env].ecsConfig.redis.memory,
        dummy: false,
      },
      redisSecurityGroup,
      { name: 'graasp-redis', port: REDIS_PORT },
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
        ],
        exposeHeaders: [],
      },
    ];

    const websites: Record<string, GraaspWebsiteConfig> = {
      analytics: { corsConfig: [] },
      apps: { corsConfig: [] },
      assets: { corsConfig: [] },
      builder: { corsConfig: [] },
      h5p: { corsConfig: H5P_CORS, bucketOwnership: 'BucketOwnerEnforced' },
      maintenance: { corsConfig: [] },
      map: { corsConfig: [] },
      client: { corsConfig: [], apexDomain: true },
    };

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
        sslCertificateCloudfront,
        environment,
        !!bucket.websiteConfiguration,
      );
    }
    // File item storage is private
    new GraaspS3Bucket(this, `${id}-file-items`, false, FILE_ITEM_CORS);
  }
}

const app = new App();

// Each stack has its own state stored in a pre created S3 Bucket
new GraaspStack(app, 'graasp-dev', {
  env: Environment.DEV,
  subdomain: 'dev',
  region: DEFAULT_REGION,
});

new GraaspStack(app, 'graasp-staging', {
  env: Environment.STAGING,
  subdomain: 'stage',
  region: AllowedRegion.Zurich,
});

new GraaspStack(app, 'graasp-prod', {
  env: Environment.PRODUCTION,
  region: AllowedRegion.Zurich,
});

app.synth();
