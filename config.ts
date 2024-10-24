import { Environment } from './utils';

export type HardwareLimit = {
  cpu: string;
  memory: string;
};

export type GraaspConfiguration = {
  enableRedisReplication: boolean;
  dbConfig: {
    graasp: {
      enableReplication: boolean;
      backupRetentionPeriod: number; // day
    };
    etherpad: {
      backupRetentionPeriod: number; // day
    };
  };
  ecsConfig: {
    // graasp: HardwareLimit, // These do not make sense as the task definition are replaced by deployment.
    // library: HardwareLimit,
    graasp: {
      taskCount: number;
    };
    etherpad: HardwareLimit;
    meilisearch: HardwareLimit;
    nudenet: HardwareLimit;
    iframely: HardwareLimit;
  };
};

/*
    This config represents the configuration option that might change between environment.
*/

export const CONFIG: Record<Environment, GraaspConfiguration> = {
  [Environment.DEV]: {
    enableRedisReplication: false,
    dbConfig: {
      graasp: {
        enableReplication: false,
        backupRetentionPeriod: 1,
      },
      etherpad: {
        backupRetentionPeriod: 1,
      },
    },
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
      nudenet: {
        cpu: '256',
        memory: '512',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
    },
  },
  [Environment.STAGING]: {
    enableRedisReplication: true,
    dbConfig: {
      graasp: {
        enableReplication: true,
        backupRetentionPeriod: 1,
      },
      etherpad: {
        backupRetentionPeriod: 1,
      },
    },
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
      nudenet: {
        cpu: '256',
        memory: '512',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
    },
  },
  [Environment.PRODUCTION]: {
    enableRedisReplication: true,
    dbConfig: {
      graasp: {
        enableReplication: true,
        backupRetentionPeriod: 7,
      },
      etherpad: {
        backupRetentionPeriod: 7,
      },
    },
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
      nudenet: {
        cpu: '256',
        memory: '512',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
    },
  },
};
