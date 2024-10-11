import { ElasticacheCluster } from '@cdktf/provider-aws/lib/elasticache-cluster';
import { ElasticacheReplicationGroup } from '@cdktf/provider-aws/lib/elasticache-replication-group';
import { ElasticacheSubnetGroup } from '@cdktf/provider-aws/lib/elasticache-subnet-group';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { Token } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { securityGroupOnlyAllowAnotherSecurityGroup } from './security_group';

export class GraaspRedis extends Construct {
  constructor(
    scope: Construct,
    id: string,
    vpc: Vpc,
    allowedSecurityGroup: SecurityGroup,
    addReplication: boolean,
  ) {
    super(scope, `${id}-redis`);

    const redisSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${id}-redis`,
      vpc.vpcIdOutput,
      allowedSecurityGroup,
      6379,
    );

    const redisSubnetGroup = new ElasticacheSubnetGroup(
      this,
      `${id}-redis-subnet-group`,
      {
        name: id,
        subnetIds: Token.asList(vpc.publicSubnetsOutput),
      },
    );

    if (addReplication) {
      new ElasticacheReplicationGroup(this, `${id}-redis`, {
        applyImmediately: true,
        replicationGroupId: `${id}-redis`,
        description: `${id}-redis`,
        engine: 'redis',
        engineVersion: '6.2',
        nodeType: 'cache.t3.micro',
        numNodeGroups: 1,
        replicasPerNodeGroup: 2,
        parameterGroupName: 'default.redis6.x',
        port: 6379,
        subnetGroupName: redisSubnetGroup.name,
        securityGroupIds: [redisSecurityGroup.id],
      });
    } else {
      new ElasticacheCluster(this, `${id}-redis`, {
        applyImmediately: true,
        clusterId: `${id}-redis`,
        engine: 'redis',
        engineVersion: '6.2',
        nodeType: 'cache.t3.micro',
        numCacheNodes: 1,
        parameterGroupName: 'default.redis6.x',
        port: 6379,
        subnetGroupName: redisSubnetGroup.name,
        securityGroupIds: [redisSecurityGroup.id],
      });
    }

    // Default already exist?

    // new ElasticacheUser(this, `${id}-redis-user`, {
    //   accessString: "on ~* +@all",
    //   engine: "REDIS",
    //   authenticationMode: {
    //     type: "no-password-required"
    //   },
    //   userId: "default",
    //   userName: "default",
    // });
  }
}
