import { RdsInstanceState } from '@cdktf/provider-aws/lib/rds-instance-state';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { TerraformVariable, Token } from 'cdktf';

import { Construct } from 'constructs';

import { Rds, RdsConfig } from '../.gen/modules/rds';
import { Vpc } from '../.gen/modules/vpc';
import {
  AllowedSecurityGroupInfo,
  securityGroupAllowMultipleOtherSecurityGroups,
} from './security_group';

export class PostgresDB extends Construct {
  public instance: Rds;
  private readonly securityGroup: SecurityGroup;
  private readonly dbPort = 5432;

  constructor(
    scope: Construct,
    name: string,
    {
      dbName,
      dbUsername,
      dbPassword,
      addReplica,
      isActive,
      vpc,
    }: {
      dbName: string;
      dbUsername: string;
      dbPassword: TerraformVariable;
      addReplica: boolean;
      vpc: Vpc;
      isActive: boolean;
    },
    allowedSecurityGroups: AllowedSecurityGroupInfo[],
    backupRetentionPeriod: number,
    configOverride?: Partial<RdsConfig>,
    gateKeeperSecurityGroup?: SecurityGroup,
  ) {
    super(scope, `${name}-postgres`);

    this.securityGroup = securityGroupAllowMultipleOtherSecurityGroups(
      this,
      `${name}-db`,
      vpc.vpcIdOutput,
      allowedSecurityGroups,
      this.dbPort,
    );

    // allow a gatekeeper for manual migrations
    if (gateKeeperSecurityGroup) {
      // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
      // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
      new VpcSecurityGroupIngressRule(
        scope,
        `${name}-allow-gatekeeper-on-postgres`,
        {
          referencedSecurityGroupId: gateKeeperSecurityGroup.id, // allowed source security group
          fromPort: this.dbPort,
          ipProtocol: 'tcp',
          securityGroupId: this.securityGroup.id,
          toPort: this.dbPort,
        },
      );
    }

    const defaultConfig: RdsConfig = {
      identifier: `${name}`,

      engine: 'postgres',
      engineVersion: '15.8',
      instanceClass: 'db.t3.micro',
      multiAz: false,
      availabilityZone: vpc.azs?.[0],
      storageType: 'gp2',
      allocatedStorage: 20,
      maxAllocatedStorage: 1000,
      publiclyAccessible: false,

      createDbOptionGroup: false,
      createDbSubnetGroup: true,
      subnetIds: Token.asList(vpc.publicSubnetsOutput),
      createDbParameterGroup: true,
      autoMinorVersionUpgrade: true,
      enabledCloudwatchLogsExports: undefined, // None
      deletionProtection: true,
      applyImmediately: true,

      parameterGroupName: 'graasp-postgres15',
      family: 'postgres15',
      parameters: [{ name: 'rds.force_ssl', value: '0' }],

      dbName: dbName,
      port: String(this.dbPort),
      username: dbUsername,
      password: dbPassword.value,
      manageMasterUserPassword: false,

      maintenanceWindow: 'Sat:00:08-Sat:00:38',
      backupWindow: '21:30-22:00',
      backupRetentionPeriod,
      copyTagsToSnapshot: true,

      performanceInsightsEnabled: true,
      // performanceInsightsKmsKeyId: "" // Looks like it's working manually providing it
      performanceInsightsRetentionPeriod: 7, // days
      createMonitoringRole: true,
      monitoringInterval: 60, // seconds
      monitoringRoleName: `${name}-rds-monitoring-role`,
      vpcSecurityGroupIds: [this.securityGroup.id],
    };

    // Doc: https://registry.terraform.io/modules/terraform-aws-modules/rds/aws/latest#inputs
    this.instance = new Rds(this, 'db', {
      ...defaultConfig,
      ...configOverride,
    });

    if (addReplica) {
      new Rds(this, 'db-replica', {
        ...defaultConfig,
        ...configOverride,
        replicateSourceDb: this.instance.dbInstanceIdentifierOutput,
        skipFinalSnapshot: true,
        copyTagsToSnapshot: false,
        snapshotIdentifier: undefined,

        // handled by replication
        dbName: undefined,
        password: undefined,
        createMonitoringRole: false,
        createDbSubnetGroup: false,
        dbSubnetGroupName: undefined,

        identifier: `${name}-replica`,
        availabilityZone: vpc.azs?.[2],
        monitoringRoleArn: this.instance.enhancedMonitoringIamRoleArnOutput,
      });
    }

    // manage instance state based on the `isActive` param
    new RdsInstanceState(this, `${this.instance.identifier}-instance-state`, {
      identifier: this.instance.identifier,
      // A bug makes it impossible to activate a database in the "stopped" state.
      // The state of the db is expected to be "available" before performing the state change...
      // Bur report tracking the issue: https://github.com/hashicorp/terraform-provider-aws/issues/40785
      state: isActive ? 'available' : 'stopped',
    });
  }

  addAllowedSecurityGroup(
    id: string,
    { targetName, groupId }: AllowedSecurityGroupInfo,
  ) {
    new VpcSecurityGroupIngressRule(
      this,
      `${id}-allow-${targetName}-on-database`,
      {
        referencedSecurityGroupId: groupId, // security group we want to allow as source
        ipProtocol: 'tcp',
        securityGroupId: this.securityGroup.id,
        fromPort: this.dbPort,
        toPort: this.dbPort,
      },
    );
  }
}
