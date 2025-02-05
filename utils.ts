import { S3BucketCorsConfigurationCorsRule } from '@cdktf/provider-aws/lib/s3-bucket-cors-configuration';

import { S3BucketObjectOwnership } from './constructs/bucket';

export const GRAASP_ROOT_DOMAIN = 'graasp.org';

export const Environment = {
  DEV: 'dev',
  STAGING: 'stage',
  PRODUCTION: 'production',
} as const;
export type EnvironmentOptions = (typeof Environment)[keyof typeof Environment];

export const AllowedRegion = {
  Frankfurt: 'eu-central-1',
  Zurich: 'eu-central-2',
} as const;
export type AllowedRegionOptions =
  (typeof AllowedRegion)[keyof typeof AllowedRegion];

export const SpotPreference = {
  OnlySpot: 'OnlySpot',
  NoSpot: 'NoSpot',
  UpscaleWithSpot: 'UpscaleWithSpot',
} as const;

export type SpotPreferenceOptions =
  (typeof SpotPreference)[keyof typeof SpotPreference];

export type EnvironmentConfig = {
  env: EnvironmentOptions;
  subdomain?: string;
  region: AllowedRegionOptions;
};

export type GraaspWebsiteConfig = {
  apexDomain?: boolean;
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
