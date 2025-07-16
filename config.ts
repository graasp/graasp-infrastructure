import { Environment } from './utils';

export type HardwareLimit = {
  cpu: string;
  memory: string;
};

export type GraaspConfiguration = {
  dbConfig: {
    graasp: {
      enableReplication: boolean;
      backupRetentionPeriod: number; // day
    };
  };
  ecsConfig: {
    // library: HardwareLimit,
    graasp: HardwareLimit & {
      taskCount: number;
    };
    workers: HardwareLimit;
    migrate: HardwareLimit;
    etherpad: HardwareLimit;
    meilisearch: HardwareLimit;
    iframely: HardwareLimit;
    redis: HardwareLimit;
    umami: HardwareLimit;
  };
};

/*
    This config represents the configuration option that might change between environment.
*/

export const CONFIG: Record<Environment, GraaspConfiguration> = {
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
      },
      workers: {
        cpu: '256',
        memory: '512',
      },
      migrate: {
        cpu: '256',
        memory: '512',
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '256',
        memory: '1024',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
      redis: {
        cpu: '256',
        memory: '512',
      },
      umami: {
        cpu: '256',
        memory: '512',
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
        cpu: '1024',
        memory: '2048',
        taskCount: 1,
      },
      workers: {
        cpu: '256',
        memory: '512',
      },
      migrate: {
        cpu: '256',
        memory: '512',
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '256',
        memory: '512',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
      redis: {
        cpu: '256',
        memory: '512',
      },
      umami: {
        cpu: '256',
        memory: '512',
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
        taskCount: 2,
      },
      workers: {
        cpu: '256',
        memory: '512',
      },
      migrate: {
        cpu: '256',
        memory: '512',
      },
      etherpad: {
        cpu: '256',
        memory: '512',
      },
      meilisearch: {
        cpu: '256',
        memory: '1024',
      },
      iframely: {
        cpu: '256',
        memory: '512',
      },
      redis: {
        cpu: '256',
        memory: '512',
      },
      umami: {
        cpu: '256',
        memory: '512',
      },
    },
  },
};
