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
  spotPreference?: SpotPreferenceOptions;
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
    graasp: {
      /**
       * Desired number of tasks to run
       */
      taskCount: number;
    } & ContainerConfig;
    workers: ContainerConfig;
    admin: ContainerConfig;
    migrate: ContainerConfig;
    etherpad: ContainerConfig;
    meilisearch: ContainerConfig;
    iframely: ContainerConfig;
    redis: ContainerConfig;
    umami: ContainerConfig;
    // Library manages its own container definition
    // library: ContainerConfig;
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
        cpu: '1024',
        memory: '2048',
        taskCount: 1,
        spotPreference: SpotPreference.OnlySpot,
      },
      workers: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      admin: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      migrate: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.OnlySpot,
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
        spotPreference: SpotPreference.OnlySpot,
      },
    },
  },
  [Environment.PRODUCTION]: {
    dbConfig: {
      graasp: {
        enableReplication: false,
        backupRetentionPeriod: 7,
      },
    },
    ecsConfig: {
      graasp: {
        cpu: '1024',
        memory: '2048',
        taskCount: 1,
        spotPreference: SpotPreference.UpscaleWithSpot,
      },
      workers: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.UpscaleWithSpot,
      },
      admin: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.UpscaleWithSpot,
      },
      migrate: {
        cpu: '256',
        memory: '512',
        spotPreference: SpotPreference.NoSpot,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
        // spotPreference: SpotPreference.NoSpot,
      },
      meilisearch: {
        cpu: '256',
        memory: '1024',
        // spotPreference: SpotPreference.NoSpot,
      },
      iframely: {
        cpu: '256',
        memory: '512',
        // spotPreference: SpotPreference.OnlySpot,
      },
      redis: {
        cpu: '256',
        memory: '512',
        // spotPreference: SpotPreference.NoSpot,
      },
      umami: {
        cpu: '256',
        memory: '512',
        // spotPreference: SpotPreference.NoSpot,
      },
    },
  },
};
