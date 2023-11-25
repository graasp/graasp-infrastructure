import { Construct } from 'constructs';
import { Vpc } from '../.gen/modules/vpc';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { Rds, RdsConfig } from '../.gen/modules/rds';
import { TerraformVariable, Token } from 'cdktf';
import { securityGroupOnlyAllowAnotherSecurityGroup } from './security_group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { Ec2 } from './ec2';

export class PostgresDB extends Construct {
  public instance: Rds;

  constructor(
    scope: Construct,
    name: string,
    dbName: string,
    dbUsername: string,
    dbPassword: TerraformVariable,
    vpc: Vpc,
    allowedSecurityGroup: SecurityGroup,
    addReplica: boolean,
    backupRetentionPeriod: number,
    configOverride?: Partial<RdsConfig>,
    createGateKeeper?: boolean
  ) {
    super(scope, `${name}-postgres`);

    const dbPort = 5432;

    const dbSecurityGroup = securityGroupOnlyAllowAnotherSecurityGroup(
      this,
      `${name}-db`,
      vpc.vpcIdOutput,
      allowedSecurityGroup.id,
      dbPort
    );

    // allow a gatekeeper for manual migrations
    if (createGateKeeper) {
      const gatekeeperKeyName = new TerraformVariable(
        scope,
        'GRAASP_DB_GATEKEEPER_KEY_NAME',
        {
          nullable: false,
          type: 'string',
          description: 'Keyname for the keypair for graasp db gatekeeper',
          sensitive: true,
        }
      );
      const gatekeeperAmiId = new TerraformVariable(
        scope,
        'DB_GATEKEEPER_AMI_ID',
        {
          nullable: false,
          type: 'string',
          description: 'AMI id for graasp db gatekeeper',
          sensitive: false,
        }
      );

      const gatekeeperInstanceType = new TerraformVariable(
        scope,
        'DB_GATEKEEPER_INSTANCE_TYPE',
        {
          nullable: false,
          type: 'string',
          description: 'AMI instance type for graasp db gatekeeper',
          sensitive: false,
        }
      );

      const gateKeeper = new Ec2(
        this,
        `${name}-gatekeeper`,
        vpc,
        gatekeeperKeyName,
        gatekeeperAmiId.value,
        gatekeeperInstanceType.value,
        true
      );

      // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
      // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
      new VpcSecurityGroupIngressRule(scope, `${name}-allow-gatekeeper`, {
        referencedSecurityGroupId: gateKeeper.securityGroup.id, // allowed source security group
        fromPort: dbPort,
        ipProtocol: 'tcp',
        securityGroupId: dbSecurityGroup.id,
        toPort: dbPort,
      });
    }

    const defaultConfig: RdsConfig = {
      identifier: `${name}`,

      engine: 'postgres',
      engineVersion: '15.3',
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
      parameters: [
        {
          name: 'rds.force_ssl',
          value: '0',
        },
      ],

      dbName: dbName,
      port: String(dbPort),
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
      vpcSecurityGroupIds: [dbSecurityGroup.id],
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
  }
}
