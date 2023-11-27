import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import {
  S3BucketCorsConfiguration,
  S3BucketCorsConfigurationCorsRule,
} from '@cdktf/provider-aws/lib/s3-bucket-cors-configuration';
import { S3BucketOwnershipControls } from '@cdktf/provider-aws/lib/s3-bucket-ownership-controls';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';
import { S3BucketPublicAccessBlock } from '@cdktf/provider-aws/lib/s3-bucket-public-access-block';
import { S3BucketWebsiteConfiguration } from '@cdktf/provider-aws/lib/s3-bucket-website-configuration';
import { Token } from 'cdktf';

import { Construct } from 'constructs';

export type S3BucketObjectOwnership = 'ObjectWriter' | 'BucketOwnerEnforced';

export class GraaspS3Bucket extends Construct {
  bucket: S3Bucket;
  websiteConfiguration?: S3BucketWebsiteConfiguration;

  constructor(
    scope: Construct,
    name: string,
    website: boolean,
    customCors: S3BucketCorsConfigurationCorsRule[] = [],
    bucketOwnership: S3BucketObjectOwnership = 'ObjectWriter',
  ) {
    super(scope, name);

    this.bucket = new S3Bucket(this, `bucket`, {
      bucket: `${name}`,
    });

    new S3BucketOwnershipControls(this, 's3-bucket-ownership', {
      bucket: this.bucket.id,
      rule: {
        objectOwnership: bucketOwnership,
      },
    });

    if (website) {
      this.websiteConfiguration = new S3BucketWebsiteConfiguration(
        this,
        `s3-website-configuration`,
        {
          bucket: this.bucket.id,
          indexDocument: {
            suffix: 'index.html',
          },
          errorDocument: {
            key: 'error.html',
          },
        },
      );

      // Allow public access
      new S3BucketPublicAccessBlock(this, `s3-block-public-access`, {
        blockPublicAcls: false,
        blockPublicPolicy: false,
        bucket: this.bucket.id,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      });

      const allowPublicAccess = new DataAwsIamPolicyDocument(
        this,
        'allow_public_access',
        {
          version: '2012-10-17',
          statement: [
            {
              sid: 'PublicReadForGetBucketObjects',
              effect: 'Allow',
              actions: ['s3:GetObject'],
              principals: [
                {
                  identifiers: ['*'],
                  type: '*',
                },
              ],
              resources: [`${this.bucket.arn}/*`],
            },
          ],
        },
      );

      new S3BucketPolicy(this, `s3-policy`, {
        bucket: this.bucket.id,
        policy: Token.asString(allowPublicAccess.json),
      });
    }

    if (customCors && customCors.length > 0) {
      new S3BucketCorsConfiguration(this, `s3-cors-config`, {
        bucket: this.bucket.id,
        corsRule: customCors,
      });
    }

    if (!website) {
      new S3BucketPublicAccessBlock(this, `s3-block-public-access`, {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        bucket: this.bucket.id,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }
  }
}
