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
import { GraaspRedis } from './constructs/redis';
import { securityGroupOnlyAllowAnotherSecurityGroup } from './constructs/security_group';
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
    const NUDENET_PORT = 8080;

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
      skipRegionValidation: true, // Zurich region is invalid with current version https://github.com/hashicorp/terraform-provider-aws/issues/28072
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
    const loadBalancer = new LoadBalancer(
      this,
      id,
      vpc,
      sslCertificate,
      environment,
    );

    const backendSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-backend`,
      vpc.vpcIdOutput,
      loadBalancer.securityGroup.id,
      BACKEND_PORT,
    );
    const librarySecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-library`,
      vpc.vpcIdOutput,
      loadBalancer.securityGroup.id,
      LIBRARY_PORT,
    );
    const etherpadSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-etherpad`,
      vpc.vpcIdOutput,
      loadBalancer.securityGroup.id,
      ETHERPAD_PORT,
    );

    const meilisearchSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-meilisearch`,
      vpc.vpcIdOutput,
      backendSecurityGroup.id,
      MEILISEARCH_PORT,
    );

    const nudenetSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-nudenet`,
      vpc.vpcIdOutput,
      backendSecurityGroup.id,
      NUDENET_PORT,
    );

    const iframelySecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-iframely`,
      vpc.vpcIdOutput,
      backendSecurityGroup.id,
      IFRAMELY_PORT,
    );

    const dbPassword = new TerraformVariable(this, 'GRAASP_DB_PASSWORD', {
      nullable: false,
      type: 'string',
      description: 'Admin password for the graasp database',
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

    new PostgresDB(
      this,
      id,
      'graasp',
      'graasp',
      dbPassword,
      vpc,
      backendSecurityGroup,
      CONFIG[environment.env].dbConfig.graasp.enableReplication,
      CONFIG[environment.env].dbConfig.graasp.backupRetentionPeriod,
      undefined,
      gatekeeper.instance.securityGroup,
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

    const etherpadDb = new PostgresDB(
      this,
      `${id}-etherpad`,
      'graasp_etherpad',
      'graasp_etherpad',
      etherpadDbPassword,
      vpc,
      etherpadSecurityGroup,
      false,
      CONFIG[environment.env].dbConfig.graasp.backupRetentionPeriod,
      {
        availabilityZone: vpc.azs?.[2],
      },
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
        DB_HOST: etherpadDb.instance.dbInstanceAddressOutput,
        DB_NAME: 'graasp_etherpad',
        DB_PASS: `\$\{${etherpadDb.instance.password}\}`,
        DB_PORT: '5432',
        DB_TYPE: 'postgres',
        DB_USER: 'graasp_etherpad',
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

    const nudenetDefinition = createContainerDefinitions(
      'nudenet',
      'notaitech/nudenet',
      'classifier',
      [
        {
          hostPort: NUDENET_PORT,
          containerPort: NUDENET_PORT,
        },
      ],
      {},
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
        healthCheckPath: '/status',
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
      'nudenet',
      1,
      {
        containerDefinitions: nudenetDefinition,
        cpu: CONFIG[environment.env].ecsConfig.nudenet.cpu,
        memory: CONFIG[environment.env].ecsConfig.nudenet.memory,
        dummy: false,
      },
      nudenetSecurityGroup,
      { name: 'graasp-nudenet', port: NUDENET_PORT },
      undefined,
      undefined,
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
      account: { corsConfig: [] },
      admin: { corsConfig: [] },
      analytics: { corsConfig: [] },
      apps: { corsConfig: [] },
      assets: { corsConfig: [] },
      auth: { corsConfig: [] },
      builder: { corsConfig: [] },
      h5p: { corsConfig: H5P_CORS, bucketOwnership: 'BucketOwnerEnforced' },
      landing: { corsConfig: [] },
      maintenance: { corsConfig: [] },
      map: { corsConfig: [] },
      player: { corsConfig: [] },
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

    // Redis cluster
    new GraaspRedis(
      this,
      id,
      vpc,
      backendSecurityGroup,
      CONFIG[environment.env].enableRedisReplication,
    );
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
