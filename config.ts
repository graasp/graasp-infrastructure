import { Environment } from './utils';

export type HardwareLimit = {
  cpu: string;
  memory: string;
};

export type GraaspConfiguration = {
  enableGraaspDatabaseReplication: boolean;
  enableRedisReplication: boolean;
  ecsConfig: {
    // graasp: HardwareLimit, // These do not make sense as the task definition are replaced by deployment.
    // library: HardwareLimit,
    graasp: {
      taskCount: number;
    };
    etherpad: HardwareLimit;
    meilisearch: HardwareLimit;
  };
};

/*
    This config represents the configuration option that might change between environment.
*/

export const CONFIG: Record<Environment, GraaspConfiguration> = {
  [Environment.DEV]: {
    enableGraaspDatabaseReplication: false,
    enableRedisReplication: false,
    ecsConfig: {
      graasp: {
        taskCount: 1,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '256',
        memory: '512',
      },
    },
  },
  [Environment.STAGING]: {
    enableGraaspDatabaseReplication: true,
    enableRedisReplication: true,
    ecsConfig: {
      graasp: {
        taskCount: 2,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '512',
        memory: '1024',
      },
    },
  },
  [Environment.PRODUCTION]: {
    enableGraaspDatabaseReplication: true,
    enableRedisReplication: true,
    ecsConfig: {
      graasp: {
        taskCount: 2,
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '512',
        memory: '1024',
      },
    },
  },
};
