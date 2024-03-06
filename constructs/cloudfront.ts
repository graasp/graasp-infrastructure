import { CloudfrontDistribution } from '@cdktf/provider-aws/lib/cloudfront-distribution';
import { DataAwsAcmCertificate } from '@cdktf/provider-aws/lib/data-aws-acm-certificate';

import { Construct } from 'constructs';

import { EnvironmentConfig, subdomainForEnv } from '../utils';

const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6'; // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-caching-optimized

export function makeCloudfront(
  scope: Construct,
  id: string,
  targetName: string,
  s3domain: string,
  certificate: DataAwsAcmCertificate,
  env: EnvironmentConfig,
  isUsingWebsiteEndpoint: boolean = false,
) {
  // needed for pointing to the website endpoint of s3
  const customOriginConfig = {
    httpPort: 80,
    httpsPort: 443,
    originProtocolPolicy: 'http-only',
    originSslProtocols: ['TLSv1'],
  };

  // TODO: add alternate domain name, and clean description
  return new CloudfrontDistribution(scope, `${id}-cloudfront`, {
    comment: targetName,
    enabled: true,
    origin: [
      {
        originId: targetName, // origin ids can be freely chosen
        domainName: s3domain, // we serve the website hosted by S3 here
        customOriginConfig: isUsingWebsiteEndpoint
          ? customOriginConfig
          : undefined,
      },
    ],
    aliases: [subdomainForEnv(`${targetName}`, env)],
    defaultCacheBehavior: {
      cachePolicyId: CACHING_OPTIMIZED_ID,
      allowedMethods: ['GET', 'HEAD'],
      cachedMethods: ['GET', 'HEAD'],
      targetOriginId: targetName,
      viewerProtocolPolicy: 'redirect-to-https',
    },
    customErrorResponse: [
      {
        errorCode: 403,
        errorCachingMinTtl: 10,
        responsePagePath: '/index.html',
        responseCode: 200,
      },
      {
        errorCode: 404,
        errorCachingMinTtl: 10,
        responsePagePath: '/index.html',
        responseCode: 200,
      },
    ],
    defaultRootObject: 'index.html',
    restrictions: { geoRestriction: { restrictionType: 'none' } },
    viewerCertificate: {
      acmCertificateArn: certificate.arn,
      sslSupportMethod: 'sni-only',
    },
  });
}
