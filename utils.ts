import { S3BucketCorsConfigurationCorsRule } from '@cdktf/provider-aws/lib/s3-bucket-cors-configuration';

import { S3BucketObjectOwnership } from './constructs/bucket';

export const GRAASP_ROOT_DOMAIN = 'graasp.org';

export enum Environment {
  DEV,
  STAGING,
  PRODUCTION,
}

export enum AllowedRegion {
  Francfort = 'eu-central-1',
  Zurich = 'eu-central-2',
}

export type EnvironmentConfig = {
  env: Environment;
  subdomain?: string;
  region: AllowedRegion;
};

export type GraaspWebsiteConfig = {
  s3StaticSite?: boolean;
  corsConfig: S3BucketCorsConfigurationCorsRule[];
  bucketOwnership?: S3BucketObjectOwnership;
};

export function subdomainForEnv(subdomain: string, env: EnvironmentConfig) {
  return env.subdomain
    ? `${subdomain}.${env.subdomain}.${GRAASP_ROOT_DOMAIN}`
    : `${subdomain}.${GRAASP_ROOT_DOMAIN}`;
}

export function envDomain(env: EnvironmentConfig) {
  return env.subdomain
    ? `${env.subdomain}.${GRAASP_ROOT_DOMAIN}`
    : `${GRAASP_ROOT_DOMAIN}`;
}
