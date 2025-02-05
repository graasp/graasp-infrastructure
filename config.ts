import {
  Environment,
  EnvironmentOptions,
  SpotPreference,
  SpotPreferenceOptions,
} from './utils';

export type HardwareLimit = {
  cpu: string;
  memory: string;
};

export type DeploymentTargetPreference = {
  /**
   * Container preference regarding choosing between spot instances (spare capacity, cheaper) or regular instances
   *
   * Recommended setting is: use OnlySpot for dev and maybe staging, in prod only use spot capacity for services that are stateless
   * and fault tolerant.
   *
   * In production set `UpscaleWithSpot` for services that may auto-scale and for which it is OK to use spot capacity.
   * A base instance **not** using spot capacity will always be used, while the next instances will use spot capacity
   *
   */
  spotPreference: SpotPreferenceOptions;
};

type ContainerConfig = HardwareLimit & DeploymentTargetPreference;

export type GraaspConfiguration = {
  dbConfig: {
    graasp: {
      /**
       * Whether to enable database replication
       */
      enableReplication: boolean;
      /**
       * Retention period in days
       */
      backupRetentionPeriod: number;
    };
  };
  ecsConfig: {
    // graasp: HardwareLimit, // These do not make sense as the task definition are replaced by deployment.
    // library: HardwareLimit,
    graasp: {
      /**
       * Desired number of tasks to run
       */
      taskCount: number;
    } & DeploymentTargetPreference;
    etherpad: ContainerConfig;
    meilisearch: ContainerConfig;
    iframely: ContainerConfig;
    redis: ContainerConfig;
    umami: ContainerConfig;
  };
};

/*
    This config represents the configuration option that might change between environment.
*/

export const CONFIG: Record<EnvironmentOptions, GraaspConfiguration> = {
  [Environment.DEV]: {
    dbConfig: {
      graasp: {
        enableReplication: false,
        backupRetentionPeriod: 1,
      },
    },
    ecsConfig: {
      graasp: {
        taskCount: 1,
        spotPreference: SpotPreference.OnlySpot,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      meilisearch: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      iframely: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      redis: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      umami: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
    },
  },
  [Environment.STAGING]: {
    dbConfig: {
      graasp: {
        enableReplication: false,
        backupRetentionPeriod: 1,
      },
    },
    ecsConfig: {
      graasp: {
        taskCount: 1,
        spotPreference: SpotPreference.UpscaleWithSpot,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      meilisearch: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      iframely: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      redis: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      umami: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
    },
  },
  [Environment.PRODUCTION]: {
    dbConfig: {
      graasp: {
        enableReplication: true,
        backupRetentionPeriod: 7,
      },
    },
    ecsConfig: {
      graasp: {
        taskCount: 2,
        spotPreference: SpotPreference.UpscaleWithSpot,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      meilisearch: {
        cpu: '256',
        memory: '1024',
        spotPreference: SpotPreference.NoSpot,
      },
      iframely: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      redis: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      umami: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
    },
  },
};
