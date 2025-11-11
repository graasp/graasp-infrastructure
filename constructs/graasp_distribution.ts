import { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import { CloudfrontOriginAccessControl } from '@cdktf/provider-aws/lib/cloudfront-origin-access-control';
import { CloudfrontOriginRequestPolicy } from '@cdktf/provider-aws/lib/cloudfront-origin-request-policy';
import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';

import { Construct } from 'constructs';

const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6'; // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-caching-optimized
const CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'; // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled

const Origins = {
  S3_ORIGIN: 's3-origin',
  API_ORIGIN: 'api-origin',
};
type GraaspDistributionProps = {
  /**
   * Domain name of the cloudfront distribution (i.e: graasp.org)
   */
  domainName: string;
  /**
   * DNS name of the Load Balancer for the API target (i.e: dualstack.eu-central-1.elb.amazonaws.com)
   */
  albDNSName: string;
  /**
   * Certificate to attach to the distribution
   */
  certificate: DataAwsAcmCertificate;
};

export class GraaspDistribution extends Construct {
  private readonly bucket: S3Bucket;
  private readonly distribution: CloudfrontDistribution;

  constructor(scope: Construct, id: string, props: GraaspDistributionProps) {
    super(scope, id);

    // define bucket
    this.bucket = new S3Bucket(this, 'client-bucket', {
      bucket: `${id}-client`,
    });

    // define origin access control (OAC)
    const oac = new CloudfrontOriginAccessControl(
      this,
      'client-origin-access-control',
      {
        name: 'client-origin-access-control',
        description: 'Client Origin Access Control',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    );

    const allowAllOriginRequestPolicy = new CloudfrontOriginRequestPolicy(
      this,
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
    this.distribution = new CloudfrontDistribution(
      this,
      'graasp-origin-cf-distribution',
      {
        enabled: true,
        isIpv6Enabled: true,
        comment: 'Graasp Origin CloudFront Distribution',
        defaultRootObject: 'index.html',
        aliases: [`${props.domainName}`],

        origin: [
          // S3 Origin
          {
            domainName: this.bucket.bucketRegionalDomainName,
            originId: Origins.S3_ORIGIN,
            originAccessControlId: oac.id,
          },
          // API origin
          {
            domainName: `${props.domainName}`,
            originId: Origins.API_ORIGIN,
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2'],
              // THINK: not sure we need to set these to hardcoded values.
              // originReadTimeout: 60,
              // originKeepaliveTimeout: 5,
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
      this,
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
            resources: [`${this.bucket.arn}/*`],
            condition: [
              {
                test: 'StringEquals',
                variable: 'AWS:SourceArn',
                values: [this.distribution.arn],
              },
            ],
          },
        ],
      },
    );
    // attach it to the bucket
    new S3BucketPolicy(this, 'client-bucket-policy', {
      bucket: this.bucket.id,
      policy: bucketPolicy.json,
    });
  }
}
