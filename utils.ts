import { S3BucketCorsConfigurationCorsRule } from '@cdktf/provider-aws/lib/s3-bucket-cors-configuration';

import { S3BucketObjectOwnership } from './constructs/bucket';

export const GRAASP_ROOT_DOMAIN = 'graasp.org';

export enum Environment {
  DEV,
  STAGING,
  PRODUCTION,
}

export const AllowedRegion = {
  Francfort: 'eu-central-1',
  Zurich: 'eu-central-2',
} as const;
export type AllowedRegionOptions =
  (typeof AllowedRegion)[keyof typeof AllowedRegion];

const InfraState = {
  /**
   * The infrastructure operates in "normal" mode, all services are up, and there is not filtering on requests
   */
  Running: 'running',
  /**
   * The infrastructure is operating in "restricted" mode, only requests that are performed with specific headers are allowed.
   * This mode is useful for testing that everything works after a large change.
   */
  Restricted: 'restricted',
  /**
   * The infrastructure is mostly down, all services are stopped, only the database is still accessible, so migrations can be performed
   */
  DBOnly: 'db-only',
  /**
   * The infrastructure is completely down, no services are running, the database is turned off.
   * This is a state that should be used during the night and the weekends to reduce costs on low-usage environnement (dev)
   * or, while we do not have new changes in "staging".
   */
  Stopped: 'stopped',
} as const;
export type InfraStateOptions = (typeof InfraState)[keyof typeof InfraState];

export type EnvironmentConfig = {
  env: Environment;
  subdomain?: string;
  region: AllowedRegionOptions;
  infraState: InfraStateOptions;
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

const VALID_INFRA_STATES = Object.values(InfraState) as string[];
export function validateInfraState(
  infraState: string | undefined,
): InfraStateOptions {
  // default if nothing is provided
  if (infraState === undefined) {
    return InfraState.Running;
  }
  // if a state is provided it should match one of the allowed states
  if (!VALID_INFRA_STATES.includes(infraState)) {
    throw new Error(
      `INFRA_STATE should be one of: ${Object.values(InfraState).join(', ')}. Provided: ${infraState}`,
    );
  }
  return infraState as InfraStateOptions;
}

export function getInfraState(environment: EnvironmentConfig): {
  isMaintenanceActive: boolean;
  isDatabaseActive: boolean;
  areServicesActive: boolean;
} {
  const { infraState } = environment;
  switch (infraState) {
    case InfraState.Stopped:
      return {
        isMaintenanceActive: true,
        isDatabaseActive: false,
        areServicesActive: false,
      };
    case InfraState.DBOnly:
      return {
        isMaintenanceActive: true,
        isDatabaseActive: true,
        areServicesActive: false,
      };
    case InfraState.Restricted:
      return {
        isMaintenanceActive: true,
        isDatabaseActive: true,
        areServicesActive: true,
      };
    case InfraState.Running:
    default:
      return {
        isMaintenanceActive: false,
        isDatabaseActive: true,
        areServicesActive: true,
      };
  }
}

export function getMaintenanceHeaders(
  environment: EnvironmentConfig,
): { name: string; value: string } | undefined {
  if (getInfraState(environment).isMaintenanceActive === false) {
    return undefined;
  }
  const name = process.env.MAINTENANCE_HEADER_NAME;
  const value = process.env.MAINTENANCE_HEADER_SECRET;
  if (!name || !value) {
    throw new Error('Expected to have a maintenance header name and value');
  }
  return { name, value };
}
