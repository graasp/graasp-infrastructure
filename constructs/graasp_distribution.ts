import { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import { CloudfrontOriginAccessControl } from '@cdktf/provider-aws/lib/cloudfront-origin-access-control';
import { CloudfrontOriginRequestPolicy } from '@cdktf/provider-aws/lib/cloudfront-origin-request-policy';
import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { Lb } from '@cdktf/provider-aws/lib/lb';
import {
  Route53Record,
  Route53RecordConfig,
} from '@cdktf/provider-aws/lib/route53-record';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';
import { S3BucketWebsiteConfiguration } from '@cdktf/provider-aws/lib/s3-bucket-website-configuration';

import { Construct } from 'constructs';

const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6'; // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-caching-optimized
const CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'; // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled

const Origins = {
  S3_ORIGIN: 's3-origin',
  API_ORIGIN: 'api-origin',
};
type GraaspDistributionProps = {
  /**
   * The Route 53 Hosted Zone ID. Used to configure the DNS records for the single origin
   */
  hostedZoneId: string;
  /**
   * Domain name of the cloudfront distribution (i.e: graasp.org)
   */
  domainName: string;
  /**
   * Load Balancer for the API target (i.e: dualstack.eu-central-1.elb.amazonaws.com)
   */
  alb: Lb;
  /**
   * Certificate to attach to the distribution
   */
  certificate: DataAwsAcmCertificate;
};

export function createClientStack(
  scope: Construct,
  id: string,
  props: GraaspDistributionProps,
) {
  // define bucket which hosts the client SPA
  const clientBucket = new S3Bucket(scope, 'bucket', {
    bucket: `${id}-client`,
  });
  // we need a s3website hosting configuration otherwise requests to paths inside the app will fail, they need to be redirected to the index.html file
  const clientBucketWebsiteConfiguration = new S3BucketWebsiteConfiguration(
    scope,
    `s3-website-configuration`,
    {
      bucket: clientBucket.id,
      indexDocument: {
        suffix: 'index.html',
      },
    },
  );

  // define origin access control (OAC)
  const oac = new CloudfrontOriginAccessControl(
    scope,
    `${id}-origin-access-control`,
    {
      name: `${id}-origin-access-control`,
      description: 'Client Origin Access Control',
      originAccessControlOriginType: 's3',
      signingBehavior: 'always',
      signingProtocol: 'sigv4',
    },
  );

  const allowAllOriginRequestPolicy = new CloudfrontOriginRequestPolicy(
    scope,
    'allow-all-origin-request-policy',
    {
      name: 'allow-all-origin-request-policy',
      comment: 'Allow all origin request policy',
      cookiesConfig: {
        cookieBehavior: 'all',
      },
      headersConfig: {
        headerBehavior: 'allViewer',
      },
      queryStringsConfig: {
        queryStringBehavior: 'all',
      },
    },
  );

  // cloudfront distribution
  const clientDistribution = new CloudfrontDistribution(
    scope,
    `${id}-client-distribution`,
    {
      enabled: true,
      isIpv6Enabled: true,
      comment: 'client',
      defaultRootObject: 'index.html',
      aliases: [`${props.domainName}`],

      origin: [
        // S3 Origin
        {
          domainName: clientBucketWebsiteConfiguration.websiteDomain,
          originId: Origins.S3_ORIGIN,
          originAccessControlId: oac.id,
          // we need to use custom origin config since we serve it from the website endpoint
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: 'https-only',
            originSslProtocols: ['TLSv1.2'],
          },
        },
        // API origin
        {
          domainName: `${props.alb.dnsName}`,
          originId: Origins.API_ORIGIN,
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: 'https-only',
            originSslProtocols: ['TLSv1.2'],
          },
        },
      ],

      // Default behaviour for s3
      defaultCacheBehavior: {
        cachePolicyId: CACHING_OPTIMIZED_ID,
        targetOriginId: Origins.S3_ORIGIN,
        viewerProtocolPolicy: 'redirect-to-https',
        allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
        cachedMethods: ['GET', 'HEAD'],
      },

      // define cache behaviour for API
      orderedCacheBehavior: [
        {
          pathPattern: '/api/*',
          targetOriginId: Origins.API_ORIGIN,
          cachePolicyId: CACHING_DISABLED_ID,
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: [
            'GET',
            'HEAD',
            'OPTIONS',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
          ],
          cachedMethods: ['GET', 'HEAD'],
          originRequestPolicyId: allowAllOriginRequestPolicy.id,
        },
      ],

      restrictions: {
        geoRestriction: {
          restrictionType: 'none',
        },
      },
      viewerCertificate: {
        acmCertificateArn: props.certificate.arn,
        sslSupportMethod: 'sni-only', // how cloudfront serves HTTPS content
      },
    },
  );

  // create a policy document that allows CloudFront to read objects from the s3 bucket
  const bucketPolicy = new DataAwsIamPolicyDocument(
    scope,
    'client-bucket-policy-document',
    {
      statement: [
        {
          sid: 'AllowCloudfrontToRead',
          effect: 'Allow',
          principals: [
            { type: 'Service', identifiers: ['cloudfront.amazonaws.com'] },
          ],
          actions: ['s3:GetObject'],
          resources: [`${clientBucket.arn}/*`],
          condition: [
            {
              test: 'StringEquals',
              variable: 'AWS:SourceArn',
              values: [clientDistribution.arn],
            },
          ],
        },
      ],
    },
  );
  // attach it to the bucket
  new S3BucketPolicy(scope, 'client-bucket-policy', {
    bucket: clientBucket.id,
    policy: bucketPolicy.json,
  });

  // setup DNS records in the hosted Zone
  // CF distribution
  const cfDistributionRecordConfig = {
    zoneId: props.hostedZoneId,
    name: props.domainName, // i.e: dev.graasp.org or graasp.org
    type: 'A',
    alias: {
      name: clientDistribution.domainName,
      zoneId: clientDistribution.hostedZoneId,
      evaluateTargetHealth: true,
    },
  } satisfies Route53RecordConfig;
  new Route53Record(
    scope,
    `${id}-distribution-A-record`,
    cfDistributionRecordConfig,
  );
  new Route53Record(scope, `${id}-distribution-AAAA-record`, {
    ...cfDistributionRecordConfig,
    type: 'AAAA',
  });

  // API domain
  const apiRecordConfig = {
    zoneId: props.hostedZoneId,
    name: `api.${props.domainName}`, // i.e: api.dev.graasp.org or api.graasp.org
    type: 'A',
    alias: {
      name: props.alb.dnsName,
      zoneId: props.alb.zoneId,
      evaluateTargetHealth: true,
    },
  };
  new Route53Record(scope, `${id}-api-A-record`, apiRecordConfig);
  new Route53Record(scope, `${id}-api-AAAA-record`, {
    ...apiRecordConfig,
    type: 'AAAA',
  });
}
